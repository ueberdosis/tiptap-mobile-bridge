import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Bridge } from './bridge'
import type { Command, CommandState, EditorEvent } from './protocol'
import './editor.css'

const bridge = new Bridge()
let editor: Editor | null = null

/** Coalesce rapid selection/state updates into at most one message per `ms`. */
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

function send(event: EditorEvent): void {
  bridge.send(event)
}

function ok(id: string, result?: unknown): void {
  bridge.send({ type: 'response', id, ok: true, result })
}

function fail(id: string, code: string, message: string): void {
  bridge.send({ type: 'response', id, ok: false, error: { code, message } })
}

/**
 * Map a toggle/set/unset command to the mark or node it acts on, so we can
 * ask the editor whether it is active. e.g. toggleBold -> bold,
 * toggleBulletList -> bulletList, toggleHeading -> heading. Returns null for
 * commands with no associated mark/node (e.g. undo), which have no active state.
 */
function targetName(command: string): string | null {
  const match = command.match(/^(?:toggle|set|unset)([A-Z]\w*)$/)
  if (!match) return null
  const name = match[1]
  return name[0].toLowerCase() + name.slice(1)
}

/**
 * Build the per-command state map that drives native toolbar buttons.
 * Cheap: only inspects the current selection (isActive/can), not the whole doc.
 */
function buildCommandStates(ed: Editor): Record<string, CommandState> {
  const can = ed.can() as unknown as Record<string, () => boolean>
  const states: Record<string, CommandState> = {}
  for (const name of Object.keys(ed.commands)) {
    let canExec = false
    try {
      const probe = can[name]
      if (typeof probe === 'function') canExec = probe() === true
    } catch {
      canExec = false
    }

    let isActive = false
    const target = targetName(name)
    if (target) {
      try {
        isActive = ed.isActive(target)
      } catch {
        isActive = false
      }
    }

    states[name] = { canExec, isActive }
  }
  return states
}

// The cheap, high-frequency channel: selection + toolbar state, debounced.
const emitSelection = debounce((ed: Editor) => {
  const { from, to, empty } = ed.state.selection
  send({
    type: 'event',
    name: 'selectionChanged',
    payload: { selection: { from, to, empty }, commandStates: buildCommandStates(ed) },
  })
}, 10)

function handleInit(command: Command): void {
  if (editor) {
    fail(command.id, 'ALREADY_INITIALIZED', 'editor already initialized')
    return
  }
  const params = (command.params ?? {}) as { content?: unknown; editable?: boolean }
  editor = new Editor({
    element: document.querySelector<HTMLElement>('#editor')!,
    extensions: [StarterKit],
    content: (params.content as string | undefined) ?? '<p>Hello from Tiptap 👋</p>',
    editable: params.editable !== false,
    onCreate: ({ editor: ed }) => {
      send({
        type: 'event',
        name: 'schemaReady',
        payload: {
          nodes: Object.keys(ed.schema.nodes),
          marks: Object.keys(ed.schema.marks),
          commands: Object.keys(ed.commands),
        },
      })
      send({ type: 'event', name: 'ready', payload: {} })
      emitSelection(ed)
    },
    onUpdate: ({ editor: ed }) => {
      emitSelection(ed)
      // Bare signal: full content is fetched on demand via getJSON, not pushed.
      send({ type: 'event', name: 'contentChanged', payload: {} })
    },
    onSelectionUpdate: ({ editor: ed }) => emitSelection(ed),
  })
  ok(command.id)
}

function handleCommand(command: Command): void {
  if (command.name === 'init') {
    handleInit(command)
    return
  }
  if (!editor) {
    fail(command.id, 'NOT_INITIALIZED', 'send an init command first')
    return
  }
  try {
    switch (command.name) {
      case 'exec': {
        // Generic dispatch: run any Tiptap command by name (no per-command glue).
        const { command: name, args } = (command.params ?? {}) as {
          command: string
          args?: Record<string, unknown>
        }
        const chain = editor.chain().focus() as unknown as Record<
          string,
          (a?: unknown) => { run: () => boolean }
        >
        const runner = chain[name]
        if (typeof runner !== 'function') {
          fail(command.id, 'UNKNOWN_COMMAND', `no such command: ${name}`)
          return
        }
        const executed = args ? runner(args).run() : runner().run()
        ok(command.id, { executed })
        return
      }
      case 'setContent': {
        const { content } = (command.params ?? {}) as { content: unknown }
        editor.commands.setContent(content as string)
        ok(command.id)
        return
      }
      case 'getJSON': {
        ok(command.id, editor.getJSON())
        return
      }
      case 'setTextSelection': {
        const params = (command.params ?? {}) as { from: number; to?: number }
        const selection = params.to === undefined ? params.from : { from: params.from, to: params.to }
        editor.commands.setTextSelection(selection)
        ok(command.id)
        return
      }
      case 'focus': {
        const params = (command.params ?? {}) as { position?: 'start' | 'end' | 'all' }
        editor.commands.focus(params.position)
        ok(command.id)
        return
      }
      default:
        fail(command.id, 'UNKNOWN_COMMAND', command.name)
    }
  } catch (error) {
    fail(command.id, 'COMMAND_FAILED', String(error))
  }
}

bridge.start(handleCommand)
