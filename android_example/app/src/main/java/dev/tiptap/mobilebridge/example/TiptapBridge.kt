package dev.tiptap.mobilebridge.example

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Whether a command can run, and whether its mark/node is active at the selection.
 *  Mirrors the CommandState carried in the selectionChanged event payload. */
data class CommandState(val canExec: Boolean, val isActive: Boolean)

/** A failed command response, surfaced as a thrown exception to the awaiting caller. */
class TiptapError(val code: String, val detail: String) : Exception("$code: $detail")

/**
 * Drives a Tiptap editor running inside a [WebView] over the JSON protocol.
 *
 * Commands are sent to the editor via `window.tiptapBridge.handleCommand`; events and responses
 * arrive through the `AndroidTiptapBridge` @JavascriptInterface. Async commands (e.g. getJSON) are
 * correlated to their response by `id`. State that drives Compose ([commandStates], [lastEvent]) is
 * exposed as [StateFlow]. Mirrors TiptapBridge.swift / tiptap_bridge.dart.
 *
 * @JavascriptInterface callbacks arrive on a background (JavaBridge) thread, so every WebView call
 * is marshaled to the main thread; a WebView is not thread-safe.
 */
class TiptapBridge {
    private var webView: WebView? = null
    private val nextId = AtomicInteger(1)
    private val pending = mutableMapOf<String, CompletableDeferred<Any?>>()

    /** Handlers the editor can invoke via a host request, keyed by request name. See [onRequest].
     *  Concurrent because it is written on the main thread (onRequest) yet read on the background
     *  @JavascriptInterface thread (handleHostRequest). */
    private val requestHandlers = ConcurrentHashMap<String, suspend (JSONObject) -> Any?>()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val _commandStates = MutableStateFlow<Map<String, CommandState>>(emptyMap())

    /** Latest per-command state (from selectionChanged); drives toolbar active styling. */
    val commandStates: StateFlow<Map<String, CommandState>> = _commandStates.asStateFlow()

    private val _lastEvent = MutableStateFlow<String?>(null)

    /** Name of the most recent event received over the bridge (drives the demo event line). */
    val lastEvent: StateFlow<String?> = _lastEvent.asStateFlow()

    /** Wire up the WebView the bridge sends commands into. Inbound messages are delivered
     *  separately through the @JavascriptInterface (see [handle]). */
    fun attach(webView: WebView) {
        this.webView = webView
    }

    /** Cancel the bridge's coroutine scope; call when the host screen is torn down (mirrors the
     *  Flutter host's dispose()). In Compose, wire it from a DisposableEffect. */
    fun dispose() {
        scope.cancel()
    }

    // Inbound (editor -> host)

    /** Decode and dispatch one inbound message body (a JSON string) from the editor. Safe to call
     *  from the background @JavascriptInterface thread. */
    fun handle(json: String) {
        val message = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        onMessage(message)
    }

    private fun onMessage(message: JSONObject) {
        when (message.optString("type")) {
            "response" -> {
                val deferred = synchronized(pending) { pending.remove(message.optString("id")) } ?: return
                if (message.optBoolean("ok")) {
                    deferred.complete(if (message.isNull("result")) null else message.opt("result"))
                } else {
                    val error = message.optJSONObject("error")
                    deferred.completeExceptionally(
                        TiptapError(
                            error?.optString("code") ?: "COMMAND_FAILED",
                            error?.optString("message") ?: "command failed",
                        ),
                    )
                }
            }

            "event" -> {
                val name = message.optString("name")
                val payload = message.optJSONObject("payload") ?: JSONObject()
                if (name == "selectionChanged") {
                    payload.optJSONObject("commandStates")?.let { states ->
                        val parsed = mutableMapOf<String, CommandState>()
                        for (key in states.keys()) {
                            val entry = states.optJSONObject(key)
                            parsed[key] = CommandState(
                                canExec = entry?.optBoolean("canExec") == true,
                                isActive = entry?.optBoolean("isActive") == true,
                            )
                        }
                        _commandStates.value = parsed
                    }
                }
                _lastEvent.value = name
            }

            "hostRequest" -> handleHostRequest(message)
        }
    }

    // Host requests (editor -> host -> editor)

    /** Register a handler the editor can invoke via a host request (e.g. `uploadImage`). The
     *  handler's resolved value becomes the reply `result`; a thrown error becomes the reply
     *  `error`. One handler per name: registering an existing name replaces it. */
    fun onRequest(name: String, handler: suspend (JSONObject) -> Any?) {
        requestHandlers[name] = handler
    }

    /** Route an inbound host request to its registered handler and reply with the outcome: the
     *  handler's resolved value as `result`, an unknown name or a thrown error as `error`. Mirrors
     *  the Flutter/iOS host request handling. */
    private fun handleHostRequest(message: JSONObject) {
        val id = message.optString("id")
        val name = message.optString("name")
        val params = message.optJSONObject("params") ?: JSONObject()
        val handler = requestHandlers[name]
        if (handler == null) {
            reply(id, ok = false, error = jsonOf("code" to "UNKNOWN_REQUEST", "message" to "no handler for \"$name\""))
            return
        }
        scope.launch {
            try {
                reply(id, ok = true, result = handler(params))
            } catch (e: Exception) {
                reply(id, ok = false, error = jsonOf("code" to "REQUEST_FAILED", "message" to (e.message ?: "$e")))
            }
        }
    }

    /** Send a reply to a host request back to the editor via `window.tiptapBridge.handleReply`.
     *  Android only sends replies; it never receives a `hostReply`. */
    private fun reply(id: String, ok: Boolean, result: Any? = null, error: JSONObject? = null) {
        val payload = JSONObject().put("type", "hostReply").put("id", id).put("ok", ok)
        if (result != null) payload.put("result", result)
        if (error != null) payload.put("error", error)
        evaluate(bridgeCallJs("handleReply", payload))
    }

    // Outbound (host -> editor)

    /** Send a command and await its `id`-correlated response. Returns the response `result` (any
     *  JSON value, possibly null); throws [TiptapError] if the editor reports failure or no webview
     *  is attached. */
    suspend fun send(name: String, params: JSONObject? = null): Any? {
        if (webView == null) throw TiptapError("NO_WEBVIEW", "bridge is not attached to a webview")

        val id = nextId.getAndIncrement().toString()
        val command = JSONObject().put("type", "command").put("id", id).put("name", name)
        if (params != null) command.put("params", params)

        val deferred = CompletableDeferred<Any?>()
        synchronized(pending) { pending[id] = deferred }
        evaluate(bridgeCallJs("handleCommand", command))
        return deferred.await()
    }

    /** Run `evaluateJavascript` on the main thread (a WebView is not thread-safe). Android's callback
     *  reports only a script's return value, not evaluation errors, so — unlike the Flutter/iOS hosts —
     *  a failed inbound eval cannot fail-fast the pending command here; the no-webview guard in [send]
     *  is the one hard failure this direction surfaces. */
    private fun evaluate(js: String) {
        mainHandler.post { webView?.evaluateJavascript(js, null) }
    }

    // Commands

    /** Create the editor (must be the first command sent). Pass [content] (an HTML string or
     *  ProseMirror JSON) to open a saved document, and `editable = false` for a read-only view;
     *  both are optional and fall back to the web side's defaults. */
    suspend fun initEditor(content: Any? = null, editable: Boolean? = null) {
        val params = JSONObject()
        if (content != null) params.put("content", content)
        if (editable != null) params.put("editable", editable)
        send("init", if (params.length() == 0) null else params)
    }

    /** Run any Tiptap command by name. [args] are positional and spread into the command. */
    suspend fun exec(command: String, args: List<Any?>? = null) {
        val params = JSONObject().put("command", command)
        if (args != null) params.put("args", JSONArray(args))
        send("exec", params)
    }

    /** Fetch the document as ProseMirror JSON. */
    suspend fun getJson(): Any? = send("getJSON")

    /** Fetch the document as an HTML string. */
    suspend fun getHtml(): Any? = send("getHTML")

    /** Start receiving the named editor event on [lastEvent]. */
    suspend fun subscribe(event: String) {
        send("subscribe", JSONObject().put("event", event))
    }

    /** Stop receiving the named editor event. */
    suspend fun unsubscribe(event: String) {
        send("unsubscribe", JSONObject().put("event", event))
    }

    companion object {
        /**
         * Build an inbound bridge call `window.tiptapBridge.<method>(<escaped json>)`. The payload is
         * serialized to JSON, then [JSONObject.quote] escapes it as a JS string literal so
         * quotes/backslashes survive embedding in JavaScript source. This is the Android counterpart
         * to the Flutter host's `jsonEncode(jsonEncode(...))`, and serves both `handleCommand`
         * (outbound commands) and `handleReply` (host-request replies).
         */
        private fun bridgeCallJs(method: String, payload: JSONObject): String =
            "window.tiptapBridge.$method(${JSONObject.quote(payload.toString())})"

        private fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
            val json = JSONObject()
            for ((key, value) in pairs) json.put(key, value)
            return json
        }
    }
}
