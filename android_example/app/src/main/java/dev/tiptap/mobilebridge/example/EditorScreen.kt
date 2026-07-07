package dev.tiptap.mobilebridge.example

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.FormatAlignCenter
import androidx.compose.material.icons.filled.FormatAlignLeft
import androidx.compose.material.icons.filled.FormatAlignRight
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListBulleted
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.FormatUnderlined
import androidx.compose.material.icons.filled.GridOn
import androidx.compose.material.icons.filled.Highlight
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LooksOne
import androidx.compose.material.icons.filled.LooksTwo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** The result of a Get JSON / Get HTML fetch, shown in a dialog. */
private data class InfoText(val title: String, val body: String)

/**
 * A toolbar button's wiring: the bridge [key] to read active state by, the Tiptap [command] to run
 * via exec, its [icon] / [description], and optional positional [args]. Mirrors a web-side
 * TOOLBAR_COMMANDS entry (key + command + args) and the Flutter/iOS toolbar tables.
 */
private data class ToolItem(
    val key: String,
    val command: String,
    val icon: ImageVector,
    val description: String,
    val args: List<Any?>? = null,
)

private val toolItems = listOf(
    ToolItem("bold", "toggleBold", Icons.Filled.FormatBold, "Bold"),
    ToolItem("italic", "toggleItalic", Icons.Filled.FormatItalic, "Italic"),
    ToolItem("underline", "toggleUnderline", Icons.Filled.FormatUnderlined, "Underline"),
    ToolItem("strike", "toggleStrike", Icons.Filled.FormatStrikethrough, "Strikethrough"),
    ToolItem("highlight", "toggleHighlight", Icons.Filled.Highlight, "Highlight"),
    ToolItem("h1", "toggleHeading", Icons.Filled.LooksOne, "Heading 1", listOf(mapOf("level" to 1))),
    ToolItem("h2", "toggleHeading", Icons.Filled.LooksTwo, "Heading 2", listOf(mapOf("level" to 2))),
    ToolItem("bulletList", "toggleBulletList", Icons.Filled.FormatListBulleted, "Bullet list"),
    ToolItem("taskList", "toggleTaskList", Icons.Filled.Checklist, "Task list"),
    ToolItem("alignLeft", "setTextAlign", Icons.Filled.FormatAlignLeft, "Align left", listOf("left")),
    ToolItem("alignCenter", "setTextAlign", Icons.Filled.FormatAlignCenter, "Align center", listOf("center")),
    ToolItem("alignRight", "setTextAlign", Icons.Filled.FormatAlignRight, "Align right", listOf("right")),
    ToolItem("table", "insertTable", Icons.Filled.GridOn, "Insert table", listOf(mapOf("rows" to 3, "cols" to 3, "withHeaderRow" to true))),
)

/**
 * The single screen: a native toolbar over the editor webview. The toolbar's buttons send `exec`
 * commands and reflect active state, both carried over the JSON bridge; the editor renders inside
 * the (visible) webview below. Mirrors the Flutter and iOS reference apps.
 */
@Composable
fun EditorScreen() {
    val bridge = remember { TiptapBridge() }
    val commandStates by bridge.commandStates.collectAsState()
    val lastEvent by bridge.lastEvent.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var linkPromptVisible by remember { mutableStateOf(false) }
    var linkUrl by remember { mutableStateOf("") }
    var info by remember { mutableStateOf<InfoText?>(null) }

    // Native photo picker: returns an image Uri, read as a base64 data URL and inserted over the
    // bridge. PickVisualMedia runs out of process, so it needs no storage permission.
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                val dataUrl = withContext(Dispatchers.IO) { readAsDataUrl(context, uri) }
                if (dataUrl != null) bridge.exec("setImage", listOf(mapOf("src" to dataUrl)))
            }
        }
    }

    // Initialize the editor once the page has loaded and the inbound bridge is installed, then
    // subscribe to focus/blur/update so the header event line lights up. The uploadImage handler is
    // registered before init so a paste can never race ahead of it. Mirrors iOS start() / Flutter onLoadStop.
    val onReady = remember(bridge, scope) {
        {
            bridge.onRequest("uploadImage") {
                delay(1000)
                "https://picsum.photos/400"
            }
            scope.launch {
                try {
                    bridge.initEditor()
                    bridge.subscribe("focus")
                    bridge.subscribe("blur")
                    bridge.subscribe("update")
                } catch (e: Exception) {
                    Log.e("tiptap", "init failed: ${e.message}")
                }
            }
            Unit
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Header: the latest editor event received over the bridge (driven by the subscribe() calls
        // in onReady); proves "receive events" end to end, like the iOS header.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Tiptap Mobile Bridge", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.weight(1f))
            Text(
                "event: ${lastEvent ?: "(none)"}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        HorizontalDivider()

        // Toolbar: each button is a plain exec(command, args); active state comes from selectionChanged.
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (item in toolItems) {
                ToolbarButton(item.icon, item.description, commandStates[item.key]?.isActive == true) {
                    scope.launch { bridge.exec(item.command, item.args) }
                }
            }
            // The link button needs a URL before it can run setLink, so it prompts rather than
            // exec-ing directly. Mirrors Flutter's _promptLink / iOS's link alert.
            ToolbarButton(Icons.Filled.Link, "Link", commandStates["link"]?.isActive == true) {
                linkPromptVisible = true
            }

            VerticalDivider(Modifier.height(24.dp))

            ToolbarButton(Icons.Filled.DataObject, "Get JSON", active = false) {
                scope.launch {
                    info = try {
                        InfoText("getJSON", stringify(bridge.getJson()))
                    } catch (e: Exception) {
                        InfoText("getJSON failed", e.message ?: "$e")
                    }
                }
            }
            ToolbarButton(Icons.Filled.Code, "Get HTML", active = false) {
                scope.launch {
                    info = try {
                        InfoText("getHTML", stringify(bridge.getHtml()))
                    } catch (e: Exception) {
                        InfoText("getHTML failed", e.message ?: "$e")
                    }
                }
            }
            // Open the native photo picker, then insert the chosen image over the bridge.
            ToolbarButton(Icons.Filled.Image, "Insert image", active = false) {
                pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
        }
        HorizontalDivider()

        // The editor itself, rendered inside the (visible) webview.
        EditorWebView(bridge = bridge, onReady = onReady, modifier = Modifier.fillMaxWidth().weight(1f))
    }

    if (linkPromptVisible) {
        AlertDialog(
            onDismissRequest = { linkPromptVisible = false; linkUrl = "" },
            title = { Text("Add link") },
            text = {
                OutlinedTextField(
                    value = linkUrl,
                    onValueChange = { linkUrl = it },
                    placeholder = { Text("https://example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val href = linkUrl.trim()
                    linkPromptVisible = false
                    linkUrl = ""
                    if (href.isNotEmpty()) scope.launch { bridge.exec("setLink", listOf(mapOf("href" to href))) }
                }) { Text("Add") }
            },
            dismissButton = {
                TextButton(onClick = { linkPromptVisible = false; linkUrl = "" }) { Text("Cancel") }
            },
        )
    }

    info?.let { item ->
        AlertDialog(
            onDismissRequest = { info = null },
            title = { Text(item.title) },
            text = {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    Text(item.body, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = { TextButton(onClick = { info = null }) { Text("Done") } },
        )
    }
}

@Composable
private fun ToolbarButton(icon: ImageVector, description: String, active: Boolean, onClick: () -> Unit) {
    if (active) {
        FilledIconButton(onClick = onClick) { Icon(icon, contentDescription = description) }
    } else {
        OutlinedIconButton(onClick = onClick) { Icon(icon, contentDescription = description) }
    }
}

/** Render a response value for display: HTML comes back as a String; JSON (a ProseMirror document)
 *  is pretty-printed. */
private fun stringify(value: Any?): String = when (value) {
    null -> "(no result)"
    is String -> value
    is JSONObject -> value.toString(2)
    is JSONArray -> value.toString(2)
    else -> value.toString()
}

/** Read a content Uri as a base64 data URL (the form the editor's setImage expects). Does I/O, so
 *  call it off the main thread. Returns null on failure. */
private fun readAsDataUrl(context: Context, uri: Uri): String? = try {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    if (bytes == null) {
        null
    } else {
        val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
} catch (e: Exception) {
    Log.e("tiptap", "image read failed: ${e.message}")
    null
}
