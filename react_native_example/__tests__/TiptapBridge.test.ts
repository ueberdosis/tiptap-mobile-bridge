/// <reference types="node" />
import { runInNewContext } from 'node:vm';
import { TiptapBridge } from '../src/TiptapBridge';

type Message = Record<string, unknown>;

/**
 * Attach a webview whose page runs every injected script, as a script, against a fake
 * `window.tiptapBridge`, so the escaping is exercised for real. Records the JSON each call delivered
 * and each script's completion value.
 */
function attachFakePage(bridge: TiptapBridge) {
  const commands: Message[] = [];
  const replies: Message[] = [];
  const results: unknown[] = [];
  const window = {
    tiptapBridge: {
      handleCommand: (json: string) => commands.push(JSON.parse(json)),
      handleReply: (json: string) => replies.push(JSON.parse(json)),
    },
  };
  const injectJavaScript = (script: string) => {
    results.push(runInNewContext(script, { window }));
  };
  bridge.attach({ current: { injectJavaScript } });
  return { commands, replies, results };
}

function deliver(bridge: TiptapBridge, message: Message): void {
  bridge.handleMessage(JSON.stringify(message));
}

/** Let async host-request handling (the awaited handler, then its reply) finish. */
const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('commands', () => {
  it('delivers each command to window.tiptapBridge.handleCommand with a fresh id', () => {
    const bridge = new TiptapBridge();
    const page = attachFakePage(bridge);
    bridge.exec('toggleHeading', [{ level: 2 }]);
    bridge.getHTML();

    expect(page.commands).toEqual([
      { type: 'command', id: '1', name: 'exec', params: { command: 'toggleHeading', args: [{ level: 2 }] } },
      { type: 'command', id: '2', name: 'getHTML' },
    ]);
    // An injected script that evaluates to nothing can fail silently in react-native-webview.
    expect(page.results).toEqual([true, true]);
  });

  it('escapes the payload so quotes, backslashes and newlines arrive intact', () => {
    const bridge = new TiptapBridge();
    const page = attachFakePage(bridge);
    const content = '<p>"double" \'single\' back\\slash\nnew line </script> ✓</p>';
    bridge.init(content, false);

    expect(page.commands).toEqual([
      { type: 'command', id: '1', name: 'init', params: { content, editable: false } },
    ]);
  });

  it('settles each command with its own response, in any order', async () => {
    const bridge = new TiptapBridge();
    attachFakePage(bridge);
    const json = bridge.getJSON();
    const html = bridge.getHTML();

    deliver(bridge, { type: 'response', id: '2', ok: true, result: '<p>Hi</p>' });
    deliver(bridge, { type: 'response', id: '1', ok: true, result: { type: 'doc' } });
    await expect(json).resolves.toEqual({ type: 'doc' });
    await expect(html).resolves.toBe('<p>Hi</p>');
  });

  it('rejects with a TiptapError carrying the editor error code', async () => {
    const bridge = new TiptapBridge();
    attachFakePage(bridge);
    const result = bridge.exec('toggleMagic');

    deliver(bridge, {
      type: 'response',
      id: '1',
      ok: false,
      error: { code: 'UNKNOWN_COMMAND', message: 'no such command: toggleMagic' },
    });
    await expect(result).rejects.toMatchObject({
      name: 'TiptapError',
      code: 'UNKNOWN_COMMAND',
      message: 'UNKNOWN_COMMAND: no such command: toggleMagic',
    });
  });

  it('fails fast with NO_WEBVIEW before a webview is attached', async () => {
    await expect(new TiptapBridge().getHTML()).rejects.toMatchObject({ code: 'NO_WEBVIEW' });
  });

  it('fails fast with INJECT_FAILED when injecting throws, leaving no timer behind', async () => {
    const bridge = new TiptapBridge();
    const injectJavaScript = () => {
      throw new Error('webview gone');
    };
    bridge.attach({ current: { injectJavaScript } });

    await expect(bridge.getHTML()).rejects.toMatchObject({
      code: 'INJECT_FAILED',
      message: 'INJECT_FAILED: Error: webview gone',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with TIMEOUT after 10 s and ignores the late response', async () => {
    const bridge = new TiptapBridge();
    attachFakePage(bridge);
    const html = bridge.getHTML();

    jest.advanceTimersByTime(10_000);
    await expect(html).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'TIMEOUT: command timed out: getHTML (1)',
    });
    expect(() => deliver(bridge, { type: 'response', id: '1', ok: true })).not.toThrow();
  });
});

describe('events', () => {
  it('turns selectionChanged into toolbar states and forwards every event', () => {
    const bridge = new TiptapBridge();
    const onCommandStates = jest.fn();
    const onEvent = jest.fn();
    bridge.onCommandStates(onCommandStates);
    bridge.onEvent(onEvent);
    const payload = {
      selection: { from: 1, to: 6, empty: false },
      commandStates: { bold: { canExec: true, isActive: true }, italic: { canExec: 'yes' } },
    };

    deliver(bridge, { type: 'event', name: 'selectionChanged', payload });
    deliver(bridge, { type: 'event', name: 'focus' });
    expect(onCommandStates).toHaveBeenCalledWith({
      bold: { canExec: true, isActive: true },
      italic: { canExec: false, isActive: false },
    });
    expect(onEvent.mock.calls).toEqual([[{ name: 'selectionChanged', payload }], [{ name: 'focus', payload: {} }]]);
  });

  it('ignores malformed JSON and unknown message types', () => {
    const bridge = new TiptapBridge();
    const onEvent = jest.fn();
    bridge.onEvent(onEvent);

    expect(() => bridge.handleMessage('{not json')).not.toThrow();
    expect(() => deliver(bridge, { type: 'somethingElse' })).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('host requests', () => {
  it('runs the registered handler and replies through window.tiptapBridge.handleReply', async () => {
    const bridge = new TiptapBridge();
    const page = attachFakePage(bridge);
    const upload = jest.fn(async () => 'https://cdn.example.com/a.png');
    bridge.onRequest('uploadImage', upload);

    deliver(bridge, { type: 'hostRequest', id: 'r1', name: 'uploadImage', params: { dataUrl: 'data:,' } });
    await flush();
    expect(upload).toHaveBeenCalledWith({ dataUrl: 'data:,' });
    expect(page.replies).toEqual([{ type: 'hostReply', id: 'r1', ok: true, result: 'https://cdn.example.com/a.png' }]);
  });

  it('replies with an error for a failing handler or an unknown request name', async () => {
    const bridge = new TiptapBridge();
    const page = attachFakePage(bridge);
    bridge.onRequest('uploadImage', async () => {
      throw new Error('offline');
    });

    deliver(bridge, { type: 'hostRequest', id: 'r1', name: 'uploadImage' });
    deliver(bridge, { type: 'hostRequest', id: 'r2', name: 'pickColor' });
    await flush();
    expect(page.replies).toHaveLength(2);
    expect(page.replies).toEqual(
      expect.arrayContaining([
        { type: 'hostReply', id: 'r1', ok: false, error: { code: 'REQUEST_FAILED', message: 'Error: offline' } },
        {
          type: 'hostReply',
          id: 'r2',
          ok: false,
          error: { code: 'UNKNOWN_REQUEST', message: 'no handler for "pickColor"' },
        },
      ]),
    );
  });
});
