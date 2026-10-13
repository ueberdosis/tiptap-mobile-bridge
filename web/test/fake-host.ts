import type { Command, EditorEvent, HostReply, HostRequest, OutboundMessage, Response } from '../src/protocol'

export type FakeHost = ReturnType<typeof installFakeHost>

/**
 * A scripted native host. It talks to the editor through the same `window.tiptapBridge` entry
 * points every real host calls, and records everything the editor sends back, parsed.
 */
export function installFakeHost() {
  const messages: OutboundMessage[] = []
  // The Android carrier is the simplest to fake: one global with a synchronous postMessage(json).
  window.AndroidTiptapBridge = {
    postMessage: (json) => {
      messages.push(JSON.parse(json) as OutboundMessage)
    },
  }
  let nextId = 1

  return {
    messages,

    /** Send a command and return its correlated response, which the editor sends synchronously. */
    command(name: string, params?: Record<string, unknown>): Response {
      const id = String(nextId++)
      const command: Command = { type: 'command', id, name, params }
      window.tiptapBridge!.handleCommand(JSON.stringify(command))
      const response = messages.find((m): m is Response => m.type === 'response' && m.id === id)
      if (!response) throw new Error(`no response to ${name} (id ${id})`)
      return response
    },

    events(name?: string): EditorEvent[] {
      return messages.filter((m): m is EditorEvent => m.type === 'event' && (name === undefined || m.name === name))
    },

    requests(): HostRequest[] {
      return messages.filter((m): m is HostRequest => m.type === 'hostRequest')
    },

    reply(reply: Omit<HostReply, 'type'>): void {
      window.tiptapBridge!.handleReply(JSON.stringify({ type: 'hostReply', ...reply }))
    },
  }
}
