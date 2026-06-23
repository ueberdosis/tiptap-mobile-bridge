import type { Command, OutboundMessage } from './protocol'

type Platform = 'flutter' | 'ios' | 'android' | 'browser'

declare global {
  interface Window {
    /** Flutter host via flutter_inappwebview: web -> native through callHandler. */
    flutter_inappwebview?: { callHandler: (name: string, ...args: unknown[]) => Promise<unknown> }
    webkit?: { messageHandlers?: { tiptapBridge?: { postMessage: (msg: string) => void } } }
    AndroidTiptapBridge?: { postMessage: (msg: string) => void }
    /** Inbound entry point the native host calls (via evaluateJavaScript) to send a command. */
    tiptapBridge?: { handleCommand: (json: string) => void }
  }
}

function detectPlatform(): Platform {
  if (window.flutter_inappwebview) return 'flutter'
  if (window.webkit?.messageHandlers?.tiptapBridge) return 'ios'
  if (window.AndroidTiptapBridge) return 'android'
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
 * - browser: window.postMessage (for testing without a native host)
 *
 * Inbound (host -> editor): the host calls window.tiptapBridge.handleCommand(json).
 */
export class Bridge {
  private readonly platform: Platform = detectPlatform()

  /** Register the inbound handler the host uses to deliver commands. */
  start(onCommand: (command: Command) => void): void {
    window.tiptapBridge = {
      handleCommand: (json: string) => {
        try {
          onCommand(JSON.parse(json) as Command)
        } catch (error) {
          console.error('[tiptap-bridge] failed to parse command', error)
        }
      },
    }

    // Browser fallback so the protocol can be exercised in a plain browser tab.
    if (this.platform === 'browser') {
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { source?: string; command?: Command }
        if (data && data.source === 'tiptap-host' && data.command) {
          onCommand(data.command)
        }
      })
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
      case 'browser':
        window.postMessage({ source: 'tiptap-editor', message }, '*')
        return
    }
  }
}
