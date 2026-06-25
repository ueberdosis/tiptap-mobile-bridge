import type { Command, CommandState, HostReply, OutboundMessage, SelectionState } from './protocol'

/**
 * Dev-only "native host" simulator.
 *
 * Drives the bridge from a plain browser tab using the same
 * `window.postMessage` channel the browser transport listens on — so it
 * exercises the exact command-dispatch / event-emit logic that runs on a
 * device. Loaded only by dev.html; never part of the production bundle.
 */

const log = document.querySelector<HTMLElement>('#log')!
let nextId = 1

function append(line: string): void {
  log.textContent = `${line}\n${log.textContent ?? ''}`
}

function send(name: string, params?: Record<string, unknown>): void {
  const id = String(nextId++)
  const command: Command = { type: 'command', id, name, params }
  window.postMessage({ source: 'tiptap-host', command }, '*')
  append(`→ ${name} ${params ? JSON.stringify(params) : ''}  (id ${id})`)
}

/** Whether the "drop next reply" box is checked; reading it consumes (unchecks) it. */
function dropNextReply(): boolean {
  const box = document.querySelector<HTMLInputElement>('#drop-reply')
  if (!box?.checked) return false
  box.checked = false
  return true
}

// Everything the editor sends back lands here.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { source?: string; message?: OutboundMessage }
  if (data?.source !== 'tiptap-editor' || !data.message) return
  const m = data.message

  // Mock host side of the request/reply direction: answer a hostRequest via handleReply.
  if (m.type === 'hostRequest') {
    append(`← hostRequest ${m.name}  (id ${m.id})`)
    if (dropNextReply()) {
      append(`   dropping reply to ${m.id} (simulating a silent host; the editor rejects on timeout)`)
      return
    }
    // Reply after a short delay so the round trip is observable and stays async.
    setTimeout(() => {
      const reply: HostReply =
        m.name === 'uploadImage'
          ? { type: 'hostReply', id: m.id, ok: true, result: 'https://picsum.photos/400' }
          : { type: 'hostReply', id: m.id, ok: false, error: { code: 'UNKNOWN_REQUEST', message: m.name } }
      window.postMessage({ source: 'tiptap-host', reply }, '*')
      append(`→ hostReply ${m.id}  ${reply.ok ? String(reply.result) : 'ERR'}`)
    }, 400)
    return
  }

  if (m.type === 'event') {
    if (m.name === 'selectionChanged') {
      const payload = m.payload as { selection: SelectionState; commandStates: Record<string, CommandState> }
      const { from, to } = payload.selection
      append(`← event selectionChanged  @${from}-${to}`)
      // Reflect active formatting on the toolbar (proves event-driven state sync).
      for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-exec]')) {
        const cmd = btn.dataset.exec!
        btn.dataset.active = String(payload.commandStates[cmd]?.isActive === true)
      }
    } else {
      append(`← event ${m.name}  ${JSON.stringify(m.payload ?? {})}`)
    }
    return
  }

  // Response (correlated by id).
  const detail = m.ok
    ? m.result !== undefined
      ? JSON.stringify(m.result).slice(0, 240)
      : ''
    : JSON.stringify(m.error)
  append(`← response id ${m.id}  ${m.ok ? 'OK' : 'ERR'}  ${detail}`)
})

// A 1x1 transparent PNG, small enough to inline so the upload round trip is testable here.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * Dispatch a synthetic image paste onto the editor, exercising the real `handlePaste` ->
 * `hostRequest('uploadImage')` -> reply -> `setImage` flow without a physical clipboard.
 */
async function simulateImagePaste(): Promise<void> {
  const blob = await (await fetch(TINY_PNG)).blob()
  const data = new DataTransfer()
  data.items.add(new File([blob], 'pasted.png', { type: 'image/png' }))
  const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
  // Some browsers ignore the constructor's clipboardData, so attach it explicitly.
  Object.defineProperty(paste, 'clipboardData', { value: data })
  const target = document.querySelector('#editor .ProseMirror') ?? document.querySelector('#editor')
  target?.dispatchEvent(paste)
  append('→ simulated image paste')
}

// Wire the toolbar buttons.
document.querySelector('#host')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button) return
  if (button.dataset.cmd === 'init') send('init')
  else if (button.dataset.cmd === 'getJSON') send('getJSON')
  else if (button.dataset.cmd === 'getHTML') send('getHTML')
  else if (button.dataset.cmd === 'upload') void simulateImagePaste()
  else if (button.dataset.subscribe) send('subscribe', { event: button.dataset.subscribe })
  else if (button.dataset.unsubscribe) send('unsubscribe', { event: button.dataset.unsubscribe })
  else if (button.dataset.exec) {
    const args = button.dataset.args ? (JSON.parse(button.dataset.args) as unknown[]) : undefined
    send('exec', { command: button.dataset.exec, args })
  }
})

append('dev host ready — click "init" first, then the formatting buttons')
