import type { Command, HostReply, OutboundMessage } from './protocol'

type Platform = 'flutter' | 'ios' | 'android' | 'reactnative' | 'browser'

/** How long a host request waits for its reply before rejecting, so a silent host cannot hang the editor. */
const REQUEST_TIMEOUT_MS = 30_000

/** A host request waiting for its reply: how to settle it, and the timer that rejects it. */
type PendingReply = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

declare global {
  interface Window {
    /** Flutter host via flutter_inappwebview: web -> native through callHandler. */
    flutter_inappwebview?: { callHandler: (name: string, ...args: unknown[]) => Promise<unknown> }
    webkit?: { messageHandlers?: { tiptapBridge?: { postMessage: (msg: string) => void } } }
    AndroidTiptapBridge?: { postMessage: (msg: string) => void }
    /**
     * React Native host via react-native-webview: web -> native through postMessage. The webview
     * injects this only when it has an `onMessage` prop set, so its presence marks the platform.
     */
    ReactNativeWebView?: { postMessage: (msg: string) => void }
    /**
     * Inbound entry points the native host calls (via evaluateJavaScript): `handleCommand`
     * delivers a command, `handleReply` delivers a reply to a host request.
     */
    tiptapBridge?: {
      handleCommand: (json: string) => void
      handleReply: (json: string) => void
    }
  }
}

function detectPlatform(): Platform {
  if (window.flutter_inappwebview) return 'flutter'
  if (window.webkit?.messageHandlers?.tiptapBridge) return 'ios'
  if (window.AndroidTiptapBridge) return 'android'
  if (window.ReactNativeWebView) return 'reactnative'
  return 'browser'
}

/**
 * Transport between the editor and the native host. Detects the platform and
 * carries JSON strings in and out — it does no editor work, only plumbing.
 *
 * Outbound (editor -> host):
 * - Flutter: window.flutter_inappwebview.callHandler('tiptapBridge', json)
 * - iOS:     window.webkit.messageHandlers.tiptapBridge.postMessage(json)
 * - Android: window.AndroidTiptapBridge.postMessage(json)
 * - React Native: window.ReactNativeWebView.postMessage(json)
 * - browser: window.postMessage (for testing without a native host)
 *
 * Inbound (host -> editor): the host calls window.tiptapBridge.handleCommand(json).
 */
export class Bridge {
  private readonly platform: Platform = detectPlatform()

  /** In-flight host requests awaiting a reply, keyed by request id. */
  private readonly pendingReplies = new Map<string, PendingReply>()

  /** Monotonic counter for editor-issued request ids (rendered `r`-prefixed). */
  private nextRequestId = 1

  /** Register the inbound handlers the host uses to deliver commands and replies. */
  start(onCommand: (command: Command) => void): void {
    window.tiptapBridge = {
      handleCommand: (json: string) => {
        try {
          onCommand(JSON.parse(json) as Command)
        } catch (error) {
          console.error('[tiptap-bridge] failed to parse command', error)
        }
      },
      handleReply: (json: string) => {
        try {
          this.settleReply(JSON.parse(json) as HostReply)
        } catch (error) {
          console.error('[tiptap-bridge] failed to parse reply', error)
        }
      },
    }

    // Browser fallback so the protocol can be exercised in a plain browser tab.
    if (this.platform === 'browser') {
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { source?: string; command?: Command; reply?: HostReply }
        if (data?.source !== 'tiptap-host') return
        if (data.command) onCommand(data.command)
        else if (data.reply) this.settleReply(data.reply)
      })
    }
  }

  /**
   * Send a request to the host and await its reply (the editor -> host direction). Resolves with the
   * reply's `result`, rejects on an error reply or if no reply arrives within
   * {@link REQUEST_TIMEOUT_MS}. The id is `r`-prefixed to stay distinct from host command ids.
   */
  request(name: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = `r${this.nextRequestId++}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id)
        reject(new Error(`host request timed out after ${REQUEST_TIMEOUT_MS}ms: ${name} (${id})`))
      }, REQUEST_TIMEOUT_MS)
      this.pendingReplies.set(id, { resolve, reject, timer })
      this.send({ type: 'hostRequest', id, name, params })
    })
  }

  /**
   * Settle the pending promise for a reply. A reply with an unknown id (e.g. one whose request
   * already timed out) is ignored, so a late host can never throw here.
   */
  private settleReply(reply: HostReply): void {
    const pending = this.pendingReplies.get(reply.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingReplies.delete(reply.id)
    if (reply.ok) {
      pending.resolve(reply.result)
    } else {
      const { code, message } = reply.error ?? { code: 'HOST_ERROR', message: 'host request failed' }
      pending.reject(new Error(`${code}: ${message}`))
    }
  }

  /** Send an event or response out to the host. */
  send(message: OutboundMessage): void {
    const json = JSON.stringify(message)
    switch (this.platform) {
      case 'flutter':
        window.flutter_inappwebview?.callHandler('tiptapBridge', json)
        return
      case 'ios':
        window.webkit?.messageHandlers?.tiptapBridge?.postMessage(json)
        return
      case 'android':
        window.AndroidTiptapBridge?.postMessage(json)
        return
      case 'reactnative':
        window.ReactNativeWebView?.postMessage(json)
        return
      case 'browser':
        window.postMessage({ source: 'tiptap-editor', message }, '*')
        return
    }
  }
}
