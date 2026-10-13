import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorEvent } from '../src/protocol'
import { installFakeHost, type FakeHost } from './fake-host'

type SelectionChanged = Extract<EditorEvent, { name: 'selectionChanged' }>

// The keys all four native toolbars look up; renaming one means updating every host.
const TOOLBAR_KEYS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'highlight',
  'h1',
  'h2',
  'bulletList',
  'taskList',
  'alignLeft',
  'alignCenter',
  'alignRight',
  'link',
  'table',
]

let host: FakeHost

beforeEach(async () => {
  vi.useFakeTimers()
  document.body.innerHTML = '<div id="editor"></div>'
  host = installFakeHost()
  // main.ts boots on import and keeps the editor in module state, so every test loads a fresh copy.
  vi.resetModules()
  await import('../src/main')
})

afterEach(() => {
  vi.clearAllTimers()
  editorElement()?.editor?.destroy()
  vi.useRealTimers()
})

function editorElement(): (HTMLElement & { editor?: Editor }) | null {
  return document.querySelector('.ProseMirror')
}

/** Let deferred work land: Tiptap's create tick, the selection debounce, focus's animation frame, file reads. */
function settle(): Promise<unknown> {
  return vi.advanceTimersByTimeAsync(50)
}

async function init(params?: Record<string, unknown>): Promise<void> {
  expect(host.command('init', params)).toMatchObject({ ok: true })
  await settle()
}

function lastSelectionChanged(): SelectionChanged['payload'] {
  return (host.events('selectionChanged').at(-1) as SelectionChanged).payload
}

/** Dispatch a paste. jsdom has no DataTransfer, so fake the parts of clipboardData that get read. */
function paste({ files = [], text = '' }: { files?: File[]; text?: string }): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const types = [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])]
  const getData = (type: string) => (type === 'text/plain' ? text : '')
  Object.defineProperty(event, 'clipboardData', { value: { files, types, getData } })
  editorElement()!.dispatchEvent(event)
}

describe('commands', () => {
  it('rejects everything but init until the editor exists', () => {
    expect(host.command('getHTML')).toEqual({
      type: 'response',
      id: '1',
      ok: false,
      error: { code: 'NOT_INITIALIZED', message: 'send an init command first' },
    })
  })

  it('answers init first, then emits schemaReady, ready and selectionChanged', async () => {
    expect(host.command('init')).toEqual({ type: 'response', id: '1', ok: true })
    expect(host.events()).toEqual([])

    await settle()
    expect(host.events().map((e) => e.name)).toEqual(['schemaReady', 'ready', 'selectionChanged'])
    expect(host.events('schemaReady')[0]).toMatchObject({
      payload: {
        nodes: expect.arrayContaining(['heading', 'taskList', 'table', 'image']),
        marks: expect.arrayContaining(['bold', 'highlight', 'link']),
        commands: expect.arrayContaining(['toggleBold', 'setTextAlign', 'insertTable']),
      },
    })
  })

  it('loads the content passed to init', async () => {
    await init({ content: '<p>Hi <strong>there</strong></p>' })
    expect(host.command('getHTML').result).toBe('<p>Hi <strong>there</strong></p>')
    expect(host.command('getJSON').result).toMatchObject({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('fails a second init with ALREADY_INITIALIZED', async () => {
    await init()
    expect(host.command('init').error?.code).toBe('ALREADY_INITIALIZED')
  })

  it('execs any Tiptap command by name, spreading object and scalar args', async () => {
    await init({ content: '<p>Title</p>' })
    expect(host.command('exec', { command: 'toggleHeading', args: [{ level: 2 }] }).result).toEqual({ executed: true })
    expect(host.command('exec', { command: 'setTextAlign', args: ['center'] }).result).toEqual({ executed: true })
    expect(host.command('getHTML').result).toContain('<h2 style="text-align: center;">Title</h2>')
  })

  it('reports executed: false when the command does not apply', async () => {
    await init()
    expect(host.command('exec', { command: 'undo' }).result).toEqual({ executed: false })
  })

  it('fails unknown exec targets and unknown commands with UNKNOWN_COMMAND', async () => {
    await init()
    expect(host.command('exec', { command: 'toggleMagic' }).error).toEqual({
      code: 'UNKNOWN_COMMAND',
      message: 'no such command: toggleMagic',
    })
    expect(host.command('rename').error).toEqual({ code: 'UNKNOWN_COMMAND', message: 'rename' })
  })

  it('turns a throwing command into COMMAND_FAILED', async () => {
    await init()
    expect(host.command('exec', { command: 'insertContentAt', args: [9999, 'x'] }).error).toEqual({
      code: 'COMMAND_FAILED',
      message: 'RangeError: Position 9999 out of range',
    })
  })

  it('replaces content silently on setContent, while an edit signals contentChanged', async () => {
    await init()
    host.command('setContent', { content: '<p>Loaded</p>' })
    await settle()
    expect(host.events('contentChanged')).toEqual([])
    expect(host.command('getHTML').result).toBe('<p>Loaded</p>')

    host.command('exec', { command: 'insertContent', args: ['!'] })
    expect(host.events('contentChanged')).toEqual([{ type: 'event', name: 'contentChanged', payload: {} }])
  })
})

describe('events', () => {
  it('reports the selection and the toolbar command states', async () => {
    await init({ content: '<p>Hello</p>' })
    host.command('setTextSelection', { from: 1, to: 6 })
    host.command('exec', { command: 'toggleBold' })
    await settle()

    const { selection, commandStates } = lastSelectionChanged()
    expect(selection).toEqual({ from: 1, to: 6, empty: false })
    expect(commandStates.bold).toEqual({ canExec: true, isActive: true })
    expect(commandStates.italic).toEqual({ canExec: true, isActive: false })
    expect(Object.keys(commandStates).sort()).toEqual([...TOOLBAR_KEYS].sort())

    host.command('setTextSelection', { from: 3 })
    await settle()
    expect(lastSelectionChanged().selection).toEqual({ from: 3, to: 3, empty: true })
  })

  it('never blurs the editor while probing toolbar state', async () => {
    await init({ content: '<p>Hello</p>' })
    host.command('subscribe', { event: 'blur' })
    host.command('focus')
    await settle()

    host.command('setTextSelection', { from: 1, to: 6 })
    host.command('exec', { command: 'toggleItalic' })
    await settle()
    expect(host.events('selectionChanged').length).toBeGreaterThan(1)
    expect(host.events('blur')).toEqual([])
    expect(document.activeElement).toBe(editorElement())
  })

  it('forwards a subscribed Tiptap event as a JSON projection until unsubscribed', async () => {
    await init({ content: '<p>Hello</p>' })
    host.command('subscribe', { event: 'update' })
    host.command('exec', { command: 'insertContent', args: ['!'] })
    expect(host.events('update')).toEqual([
      { type: 'event', name: 'update', payload: { selection: { from: 2, to: 2, empty: true }, docChanged: true } },
    ])

    host.command('unsubscribe', { event: 'update' })
    host.command('exec', { command: 'insertContent', args: ['?'] })
    expect(host.events('update')).toHaveLength(1)
    expect(host.events('transaction')).toEqual([])
  })
})

describe('host requests', () => {
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pasted.png', { type: 'image/png' })

  it('uploads a pasted image through the host and inserts the returned URL', async () => {
    await init({ content: '<p>Hello</p>' })
    host.command('subscribe', { event: 'paste' })
    paste({ files: [png()] })
    await settle()

    const [request] = host.requests()
    expect(request).toMatchObject({
      id: 'r1',
      name: 'uploadImage',
      params: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
    })
    host.reply({ id: request.id, ok: true, result: 'https://cdn.example.com/a.png' })
    await settle()
    expect(host.command('getHTML').result).toContain('<img src="https://cdn.example.com/a.png">')
    expect(host.events('paste')).toEqual([])
  })

  it('inserts nothing and logs when the host reports a failed upload', async () => {
    await init({ content: '<p>Hello</p>' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    paste({ files: [png()] })
    await settle()

    host.reply({ id: 'r1', ok: false, error: { code: 'UPLOAD_FAILED', message: 'offline' } })
    await settle()
    expect(host.command('getHTML').result).toBe('<p>Hello</p>')
    expect(error).toHaveBeenCalledWith('[tiptap-bridge] image upload failed', new Error('UPLOAD_FAILED: offline'))
  })

  it('lets a non-image paste through and forwards the paste event', async () => {
    await init({ content: '<p>Hello</p>' })
    host.command('subscribe', { event: 'paste' })
    paste({ text: 'world' })
    await settle()

    expect(host.requests()).toEqual([])
    expect(host.events('paste')).toEqual([{ type: 'event', name: 'paste', payload: { types: ['text/plain'] } }])
    expect(host.command('getHTML').result).toContain('world')
  })
})
