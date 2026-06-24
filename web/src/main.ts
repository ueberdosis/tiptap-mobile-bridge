import { Editor } from '@tiptap/core'
import { Highlight } from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { TextAlign } from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { Bridge } from './bridge'
import type { Command, CommandState, EditorEvent, ExecParams } from './protocol'
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
 * A toolbar button's wiring: the Tiptap command to run, optional args, and how to read
 * its "active" state. `key` is the stable id used both as the {@link CommandState} map
 * key and the lookup key on the native side.
 *
 * `active` may name a mark/node (optionally with attrs, e.g. heading level) or carry attrs
 * alone (e.g. `{ textAlign: 'center' }`, matching any node with that attribute). Omit
 * `active` for insert-style commands with no meaningful active state (e.g. tables).
 */
type ToolbarCommand = {
  key: string
  command: string
  /** Positional args spread into the command, e.g. `['left']` for setTextAlign, `[{ level: 1 }]` for toggleHeading. */
  args?: unknown[]
  active?: { name?: string; attrs?: Record<string, unknown> }
}

/**
 * Commands whose enabled/active state drives the native toolbar. We probe ONLY these —
 * never the full `editor.commands` set.
 *
 * `editor.can()[name]()` runs each command in dry-run mode, but some Tiptap commands don't
 * guard their side-effects behind `dispatch`: `blur`, for instance, unconditionally schedules
 * `requestAnimationFrame(() => view.dom.blur())`, so probing it blurs the editor a frame later
 * — on every keystroke. An allowlist is the robust fix (a denylist would silently break if
 * another unguarded command is added). Keep this in sync with the native toolbar's buttons.
 */
const TOOLBAR_COMMANDS: ToolbarCommand[] = [
  { key: 'bold', command: 'toggleBold', active: { name: 'bold' } },
  { key: 'italic', command: 'toggleItalic', active: { name: 'italic' } },
  { key: 'underline', command: 'toggleUnderline', active: { name: 'underline' } },
  { key: 'strike', command: 'toggleStrike', active: { name: 'strike' } },
  { key: 'highlight', command: 'toggleHighlight', active: { name: 'highlight' } },
  { key: 'h1', command: 'toggleHeading', args: [{ level: 1 }], active: { name: 'heading', attrs: { level: 1 } } },
  { key: 'h2', command: 'toggleHeading', args: [{ level: 2 }], active: { name: 'heading', attrs: { level: 2 } } },
  { key: 'bulletList', command: 'toggleBulletList', active: { name: 'bulletList' } },
  { key: 'taskList', command: 'toggleTaskList', active: { name: 'taskList' } },
  { key: 'alignLeft', command: 'setTextAlign', args: ['left'], active: { attrs: { textAlign: 'left' } } },
  { key: 'alignCenter', command: 'setTextAlign', args: ['center'], active: { attrs: { textAlign: 'center' } } },
  { key: 'alignRight', command: 'setTextAlign', args: ['right'], active: { attrs: { textAlign: 'right' } } },
  { key: 'link', command: 'setLink', active: { name: 'link' } },
  { key: 'table', command: 'insertTable' },
]

/**
 * Build the per-button state map that drives the native toolbar. Cheap and safe: probes only
 * {@link TOOLBAR_COMMANDS} against the current selection, never the full command set — see
 * TOOLBAR_COMMANDS for why probing every command can blur the editor.
 */
function buildCommandStates(ed: Editor): Record<string, CommandState> {
  const can = ed.can() as unknown as Record<string, (...args: unknown[]) => boolean>
  const states: Record<string, CommandState> = {}
  for (const item of TOOLBAR_COMMANDS) {
    let canExec = false
    try {
      const probe = can[item.command]
      if (typeof probe === 'function') canExec = (item.args ? probe(...item.args) : probe()) === true
    } catch {
      canExec = false
    }

    let isActive = false
    if (item.active) {
      try {
        isActive = item.active.name
          ? ed.isActive(item.active.name, item.active.attrs)
          : item.active.attrs
            ? ed.isActive(item.active.attrs)
            : false
      } catch {
        isActive = false
      }
    }

    states[item.key] = { canExec, isActive }
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
    extensions: [
      StarterKit,
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
    ],
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
        // Generic dispatch: run any Tiptap command by name (no per-command glue). `args` are
        // positional and spread into the command, so both object-arg commands
        // (toggleHeading([{ level: 1 }])) and scalar-arg ones (setTextAlign(['left'])) work.
        const { command: name, args } = (command.params ?? {}) as ExecParams
        const chain = editor.chain().focus() as unknown as Record<
          string,
          (...a: unknown[]) => { run: () => boolean }
        >
        const runner = chain[name]
        if (typeof runner !== 'function') {
          fail(command.id, 'UNKNOWN_COMMAND', `no such command: ${name}`)
          return
        }
        const executed = args ? runner(...args).run() : runner().run()
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
