import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bridge } from '../src/bridge'
import type { Command, OutboundMessage } from '../src/protocol'
import { installFakeHost } from './fake-host'

const ready: OutboundMessage = { type: 'event', name: 'ready', payload: {} }
const getHTML: Command = { type: 'command', id: '1', name: 'getHTML' }

afterEach(() => {
  delete window.flutter_inappwebview
  delete window.webkit
  delete window.AndroidTiptapBridge
  delete window.ReactNativeWebView
  vi.useRealTimers()
})

function startBridge(onCommand: (command: Command) => void = () => {}): Bridge {
  const bridge = new Bridge()
  bridge.start(onCommand)
  return bridge
}

describe('transport', () => {
  it('sends JSON to the Flutter handler', () => {
    const callHandler = vi.fn(() => Promise.resolve())
    window.flutter_inappwebview = { callHandler }
    new Bridge().send(ready)
    expect(callHandler).toHaveBeenCalledWith('tiptapBridge', JSON.stringify(ready))
  })

  it.each([
    ['iOS', (postMessage: (json: string) => void) => (window.webkit = { messageHandlers: { tiptapBridge: { postMessage } } })],
    ['Android', (postMessage: (json: string) => void) => (window.AndroidTiptapBridge = { postMessage })],
    ['React Native', (postMessage: (json: string) => void) => (window.ReactNativeWebView = { postMessage })],
  ])('sends JSON to the %s carrier', (_, install) => {
    const postMessage = vi.fn()
    install(postMessage)
    new Bridge().send(ready)
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify(ready))
  })

  it('falls back to window.postMessage in both directions in a plain browser tab', async () => {
    const onCommand = vi.fn()
    const bridge = startBridge(onCommand)
    const outbound = new Promise((resolve) => window.addEventListener('message', (e) => resolve(e.data), { once: true }))
    bridge.send(ready)
    expect(await outbound).toEqual({ source: 'tiptap-editor', message: ready })

    window.postMessage({ source: 'someone-else', command: { ...getHTML, id: 'ignored' } }, '*')
    window.postMessage({ source: 'tiptap-host', command: getHTML }, '*')
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith(getHTML))
    expect(onCommand).toHaveBeenCalledOnce()
  })

  it('parses commands delivered through window.tiptapBridge.handleCommand', () => {
    installFakeHost()
    const onCommand = vi.fn()
    startBridge(onCommand)
    window.tiptapBridge!.handleCommand(JSON.stringify(getHTML))
    expect(onCommand).toHaveBeenCalledWith(getHTML)
  })

  it('logs malformed JSON instead of throwing back into the host', () => {
    installFakeHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startBridge()
    expect(() => window.tiptapBridge!.handleCommand('{not json')).not.toThrow()
    expect(() => window.tiptapBridge!.handleReply('{not json')).not.toThrow()
    expect(error).toHaveBeenCalledTimes(2)
  })
})

describe('host requests', () => {
  it('sends r-prefixed requests and settles each with its own reply', async () => {
    const host = installFakeHost()
    const bridge = startBridge()
    const upload = bridge.request('uploadImage', { dataUrl: 'data:,' })
    const pick = bridge.request('pickColor')
    expect(host.requests()).toEqual([
      { type: 'hostRequest', id: 'r1', name: 'uploadImage', params: { dataUrl: 'data:,' } },
      { type: 'hostRequest', id: 'r2', name: 'pickColor' },
    ])

    host.reply({ id: 'r2', ok: true, result: '#ff0000' })
    host.reply({ id: 'r1', ok: true, result: 'https://cdn.example.com/a.png' })
    await expect(upload).resolves.toBe('https://cdn.example.com/a.png')
    await expect(pick).resolves.toBe('#ff0000')
  })

  it('rejects with the host error code and message', async () => {
    const host = installFakeHost()
    const bridge = startBridge()
    const upload = bridge.request('uploadImage')
    const malformed = bridge.request('uploadImage')

    host.reply({ id: 'r1', ok: false, error: { code: 'UPLOAD_FAILED', message: 'offline' } })
    host.reply({ id: 'r2', ok: false })
    await expect(upload).rejects.toThrow('UPLOAD_FAILED: offline')
    await expect(malformed).rejects.toThrow('HOST_ERROR: host request failed')
  })

  it('rejects after 30 s without a reply and ignores the late reply', async () => {
    vi.useFakeTimers()
    const host = installFakeHost()
    const error = vi.spyOn(console, 'error')
    const timedOut = expect(startBridge().request('uploadImage')).rejects.toThrow(
      'host request timed out after 30000ms: uploadImage (r1)',
    )
    vi.advanceTimersByTime(30_000)
    await timedOut
    host.reply({ id: 'r1', ok: true, result: 'too late' })
    expect(error).not.toHaveBeenCalled()
  })
})
