import type { Command, OutboundMessage } from './protocol'

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

// Everything the editor sends back lands here.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { source?: string; message?: OutboundMessage }
  if (data?.source !== 'tiptap-editor' || !data.message) return
  const m = data.message

  if (m.type === 'event') {
    if (m.name === 'selectionChanged') {
      const { from, to } = m.payload.selection
      append(`← event selectionChanged  @${from}-${to}`)
      // Reflect active formatting on the toolbar (proves event-driven state sync).
      for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-exec]')) {
        const cmd = btn.dataset.exec!
        btn.dataset.active = String(m.payload.commandStates[cmd]?.isActive === true)
      }
    } else {
      append(`← event ${m.name}  ${JSON.stringify(m.payload)}`)
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

// Wire the toolbar buttons.
document.querySelector('#host')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button) return
  if (button.dataset.cmd === 'init') send('init')
  else if (button.dataset.cmd === 'getJSON') send('getJSON')
  else if (button.dataset.exec) {
    const args = button.dataset.args ? (JSON.parse(button.dataset.args) as Record<string, unknown>) : undefined
    send('exec', { command: button.dataset.exec, args })
  }
})

append('dev host ready — click "init" first, then the formatting buttons')
