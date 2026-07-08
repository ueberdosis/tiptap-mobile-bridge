# Tiptap Mobile Bridge Protocol

The native host (Flutter / iOS / Android / React Native / a browser tab) and a Tiptap editor running
inside a webview communicate purely through **JSON messages**. This document is the wire
contract; it is identical on every platform, and only the carrier of the JSON differs (see
[GUIDE.md](./GUIDE.md#transport-per-platform)).

Source of truth: [`web/src/protocol.ts`](./web/src/protocol.ts) (types) and
[`web/src/main.ts`](./web/src/main.ts) (command/event behaviour).

## Model

- **Commands** flow **host → editor**. Each carries a unique `id`; the editor replies with
  exactly one **response** echoing that `id`. This is how an async result (e.g. `getJSON`)
  is correlated to its request. The correlation lives in the message, not in the transport,
  which is what keeps the protocol carrier-agnostic.
- **Events** flow **editor → host**. They carry no `id` and get no reply; they are
  fire-and-forget notifications (selection moved, content changed, editor ready).
- **Host requests** flow **editor → host** and, unlike events, await a reply. The editor
  assigns an `r`-prefixed `id` (e.g. `r1`), the host runs the handler named by the request, and
  replies once with a **host reply** echoing that `id`. It is the command/response correlation
  idea in the opposite direction. If no reply arrives within ~30s the editor rejects the request,
  so a silent host cannot hang the editor.

```
host   ──── command {id} ───────────────▶ editor
host   ◀─── response {id, ok, …} ──────── editor      (one per command)
host   ◀─── event {name, payload} ─────── editor      (unsolicited, no id)
editor ──── hostRequest {id, name} ─────▶ host
editor ◀─── hostReply {id, ok, …} ─────── host        (one per request, or a ~30s timeout)
```

## Envelopes

```ts
type Command = {
  type: 'command'
  id: string                         // correlation id; the response echoes it
  name: string                       // init | exec | getJSON | getHTML | setContent | setTextSelection | focus | subscribe | unsubscribe
  params?: Record<string, unknown>
}

type Response = {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown                   // present when ok = true (may be omitted if there is no value)
  error?: { code: string; message: string } // present when ok = false
}

type EditorEvent =
  // Always emitted, no subscription needed:
  | { type: 'event'; name: 'ready';            payload: {} }
  | { type: 'event'; name: 'schemaReady';      payload: { nodes: string[]; marks: string[]; commands: string[] } }
  | { type: 'event'; name: 'selectionChanged'; payload: { selection: SelectionState; commandStates: Record<string, CommandState> } }
  | { type: 'event'; name: 'contentChanged';   payload: {} }
  // Any other Tiptap editor event the host has subscribed to, delivered as a JSON projection:
  | { type: 'event'; name: string;             payload?: Record<string, unknown> }

type SelectionState = { from: number; to: number; empty: boolean } // ProseMirror positions
type CommandState   = { canExec: boolean; isActive: boolean }

type HostRequest = {
  type: 'hostRequest'
  id: string                         // editor-assigned, r-prefixed (r1, r2, …); the reply echoes it
  name: string                       // the host routes on this, e.g. uploadImage
  params?: Record<string, unknown>
}

type HostReply = {
  type: 'hostReply'
  id: string
  ok: boolean
  result?: unknown                   // present when ok = true (the host's answer, e.g. an uploaded URL)
  error?: { code: string; message: string } // present when ok = false
}
```

## Commands (host → editor)

| Command            | `params`                  | `result` on success           |
| ------------------ | ------------------------- | ----------------------------- |
| `init`             | `{ content?, editable? }` | `(none)`; also emits 3 events |
| `exec`             | `{ command, args? }`      | `{ executed: boolean }`       |
| `getJSON`          | `(none)`                  | ProseMirror document JSON     |
| `getHTML`          | `(none)`                  | HTML string                   |
| `setContent`       | `{ content }`             | `(none)`                      |
| `setTextSelection` | `{ from, to? }`           | `(none)`                      |
| `focus`            | `{ position? }`           | `(none)`                      |
| `subscribe`        | `{ event }`               | `(none)`                      |
| `unsubscribe`      | `{ event }`               | `(none)`                      |

**`init`** creates the editor. `content` is an HTML string or ProseMirror JSON
(default `"<p>Hello from Tiptap 👋</p>"`); `editable` defaults to `true`. On success it responds
`ok` first, then **asynchronously** emits `schemaReady` → `ready` → `selectionChanged`: the editor's
create lifecycle runs on a later tick (and `selectionChanged` is additionally debounced), so these
three arrive just *after* the `init` response, not before it. A host that needs the schema or the
initial toolbar state should wait for those events rather than assume they precede the response. It
must be the first command; sending it twice fails with `ALREADY_INITIALIZED`.

**`exec`** runs *any* Tiptap command by name (the generic escape hatch). `args` is a
**positional** array spread into the command (the editor runs
`editor.chain().focus()[command](...args).run()`), so one path serves both object-arg
commands (`toggleHeading([{ level: 2 }])`) and scalar-arg ones (`setTextAlign(['left'])`).
It focuses first, then dispatches. `result.executed` is the boolean returned by `.run()`
(i.e. whether the command applied). Unknown names fail with `UNKNOWN_COMMAND`.

```json
{ "type": "command", "id": "7", "name": "exec",
  "params": { "command": "toggleHeading", "args": [{ "level": 2 }] } }
```

**`getJSON`** returns the full document as ProseMirror JSON. Pair it with the
`contentChanged` event: that event is only a signal, so you fetch the content here, on demand.

**`getHTML`** returns the full document as an HTML string. Same idea as `getJSON`, but HTML.

**`setContent`** replaces the document. `content` is passed to `editor.commands.setContent`
(HTML string or ProseMirror JSON). A programmatic replace is silent: it does **not** emit
`contentChanged` (unlike a user edit), so loading a document never trips a `contentChanged`-based
dirty flag.

**`setTextSelection`** moves the selection. `{ from }` collapses the caret at `from`;
`{ from, to }` selects a range.

**`focus`** focuses the editor. Optional `position`: `'start' | 'end' | 'all'`.

**`subscribe`** / **`unsubscribe`** start or stop receiving a named Tiptap editor event on the
event channel. `params` is `{ event }` (e.g. `{ "event": "focus" }`). See
[Subscribable events](#subscribable-events) for the list and payloads; the four always-on events
below need no subscription.

```json
{ "type": "command", "id": "8", "name": "subscribe", "params": { "event": "focus" } }
```

## Events (editor → host)

### Always-on events

**`ready`** (`payload: {}`) signals the editor exists and can accept commands beyond `init`.

**`schemaReady`** (`payload: { nodes, marks, commands }`) is discovery: the node/mark names in
the active schema and every command name available to `exec`. It lets a host build UI without
hard-coding what the editor supports.

**`selectionChanged`** (`payload: { selection, commandStates }`) is the cheap, high-frequency
channel, **debounced ~10 ms**. `selection` is `{ from, to, empty }`. `commandStates` maps a
stable toolbar key (e.g. `bold`, `h1`, `alignLeft`) to `{ canExec, isActive }` and drives
toolbar button enabled/active styling. It contains **only the commands the toolbar needs**, not
every command (see the [`can()` side-effect gotcha](./GUIDE.md#gotcha-probing-cans-side-effects)).

**`contentChanged`** (`payload: {}`) is a bare signal that the document changed. The content
itself is **not** pushed (it could be large and fires on every keystroke); fetch it with
`getJSON`/`getHTML` when you actually need it.

### Subscribable events

The four events above are always emitted. **Every other Tiptap editor event** is delivered only
after the host `subscribe`s to it, and stops on `unsubscribe`. The raw Tiptap payloads hold live
objects (`Editor`, `Transaction`, DOM events, a `Slice`) that cannot cross a JSON boundary, so
each is delivered as a small **projection**:

| Event             | Fires when                       | `payload` projection                             |
| ----------------- | -------------------------------- | ------------------------------------------------ |
| `focus`           | the editor gains focus           | `{}`                                             |
| `blur`            | the editor loses focus           | `{}`                                             |
| `update`          | the document changes             | `{ selection: { from, to, empty }, docChanged }` |
| `selectionUpdate` | the selection changes            | `{ selection: { from, to, empty }, docChanged }` |
| `transaction`     | any state transaction is applied | `{ selection: { from, to, empty }, docChanged }` |
| `paste`           | content is pasted                | `{ types: string[] }`                            |
| `drop`            | content is dropped               | `{ types: string[], moved: boolean }`            |
| `destroy`         | the editor is destroyed          | `{}`                                             |
| `contentError`    | content fails schema validation  | `{ message: string }`                            |

For `paste`/`drop` the inserted content lands in the document; read it with `getJSON`/`getHTML`
after the event. Subscribing to a name outside this list is accepted but never fires (only these
events are forwarded). `update`/`selectionUpdate` are the raw Tiptap events; the always-on
`contentChanged`/`selectionChanged` are the convenience signals that cover the common
content/toolbar cases without a subscription.

## Host requests (editor → host)

A host request lets the editor ask the host for something it cannot produce itself (an upload, a
native picker, a lookup) and await the answer. It is the only editor-initiated direction that gets
a reply. The host registers one handler per request `name`; the name is a contract between the two
sides and a host is free to add its own.

| Request       | `params`      | `result` on success           |
| ------------- | ------------- | ----------------------------- |
| `uploadImage` | `{ dataUrl }` | the hosted image URL (string) |

**`uploadImage`** is the demo request. Pasting an image into the editor is intercepted (the default
insert is suppressed), the image is read as a base64 `dataUrl`, sent to the host, and the returned
URL is inserted. Interception is a ProseMirror paste handler. The `paste` editor event above is
emitted through that same paste handling, so intercepting an image paste suppresses its `paste`
event; a non-image paste is not intercepted and still fires `paste`.

**Id space.** Request ids are **editor-assigned** and `r`-prefixed (`r1`, `r2`, …); command ids are
**host-assigned** (the host's own counter, e.g. `1`, `2`). The two never collide even though both
correlate by `id`, because each side mints ids only for the direction it initiates.

**Timeout.** The editor starts a ~30s timer per request. If no reply arrives in time the promise
rejects (and a later reply for that id is ignored), so a slow or silent host cannot hang the editor.
A host should still reply on failure (`ok: false`) rather than stay silent, so the editor learns the
outcome immediately.

```json
{ "type": "hostRequest", "id": "r1", "name": "uploadImage",
  "params": { "dataUrl": "data:image/png;base64,iVBORw0K..." } }

{ "type": "hostReply", "id": "r1", "ok": true, "result": "https://cdn.example.com/abc.png" }
```

A failed reply mirrors a command error: `{ "type": "hostReply", "id": "r1", "ok": false, "error":
{ "code": "UPLOAD_FAILED", "message": "..." } }`. The `code`/`message` are the host's own (the
editor does not define them); the editor surfaces them as a rejected promise.

## Error codes

| `error.code`          | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `ALREADY_INITIALIZED` | `init` sent when the editor already exists.                    |
| `NOT_INITIALIZED`     | Any command other than `init` arrived before `init`.           |
| `UNKNOWN_COMMAND`     | `exec` with an unknown command name, or an unknown command.    |
| `COMMAND_FAILED`      | The handler threw while applying the command (`message` = why).|

```json
{ "type": "response", "id": "7", "ok": false,
  "error": { "code": "UNKNOWN_COMMAND", "message": "no such command: toggleMagic" } }
```

## Lifecycle

```
1. Host loads the webview; the editor registers window.tiptapBridge.handleCommand.
2. Host ──▶ init
3. Host ◀── response ok for init   (then, asynchronously: schemaReady → ready → selectionChanged)
4. Host ──▶ exec / getJSON / getHTML / setContent / subscribe / …   (each gets one response)
   Host ◀── selectionChanged / contentChanged       (always streamed as the user edits)
   Host ◀── focus / blur / update / …               (streamed only after subscribe)
```

## Transport (summary)

The JSON crosses the boundary through these globals. The host implements the outbound carrier
for its platform and always calls the same inbound entry point:

- **Inbound (host → editor):** `window.tiptapBridge.handleCommand(jsonString)` for a command,
  `window.tiptapBridge.handleReply(jsonString)` for a reply to a host request.
- **Outbound (editor → host):** Flutter `flutter_inappwebview.callHandler('tiptapBridge', json)`
  · iOS `webkit.messageHandlers.tiptapBridge.postMessage(json)`
  · Android `AndroidTiptapBridge.postMessage(json)`
  · React Native `ReactNativeWebView.postMessage(json)`
  · browser `window.postMessage({ source: 'tiptap-editor', message })`

Platform is auto-detected in [`web/src/bridge.ts`](./web/src/bridge.ts) (order:
flutter → ios → android → react native → browser). Native wiring for each is in
[GUIDE.md](./GUIDE.md#transport-per-platform).
