import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Namespace, Socket } from 'socket.io'

// Hoisted mocks for the DB / usage / workspace boundary so the test exercises
// only the omp frame -> /chat-run event + persistence mapping.
const mocks = vi.hoisted(() => ({
  addMessage: vi.fn((): number => 1),
  createSession: vi.fn(),
  getSession: vi.fn((): unknown => ({ id: 'sid', profile: 'default', workspace: '/ws', model: '', provider: '' })),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
  updateUsage: vi.fn(),
  calcAndUpdateUsage: vi.fn(),
  pushState: vi.fn(),
  ensureHermesRunWorkspace: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: mocks.addMessage,
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  updateSessionStats: mocks.updateSessionStats,
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ updateUsage: mocks.updateUsage }))
vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({ calcAndUpdateUsage: mocks.calcAndUpdateUsage }))
vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({ pushState: mocks.pushState }))
vi.mock('../../packages/server/src/services/hermes/run-chat/workspace', () => ({ ensureHermesRunWorkspace: mocks.ensureHermesRunWorkspace }))
vi.mock('../../packages/server/src/services/hermes/run-chat/content-blocks', () => ({
  contentBlocksToString: (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
  extractTextForPreview: (value: unknown) => (typeof value === 'string' ? value : ''),
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { handleOmpRun } from '../../packages/server/src/services/hermes/run-chat/handle-omp-run'
import { ompSessionManager } from '../../packages/server/src/services/hermes/run-chat/omp-session-manager'
import type { SessionState } from '../../packages/server/src/services/hermes/run-chat/types'

type Frame = Record<string, unknown>
type EmittedEvent = { event: string; payload: Record<string, unknown> }

function makeHarness() {
  const emitted: EmittedEvent[] = []
  const room = {
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload })
      return true
    },
    except: () => ({ emit: () => true }),
  }
  // Structural mocks for the socket.io boundary — only the surface handleOmpRun uses.
  const nsp = { to: () => room, adapter: { rooms: new Map<string, Set<string>>() } } as unknown as Namespace
  const socket = { id: 'sock1', connected: true, join: vi.fn(), emit: vi.fn(), to: () => room } as unknown as Socket
  return { emitted, nsp, socket }
}

function eventsNamed(emitted: EmittedEvent[], name: string): EmittedEvent[] {
  return emitted.filter(e => e.event === name)
}

describe('handleOmpRun frame mapping', () => {
  let captured: ((frame: Frame) => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockReturnValue({ id: 'sid', profile: 'default', workspace: '/ws', model: '', provider: '' })
    mocks.ensureHermesRunWorkspace.mockResolvedValue('/ws')
    mocks.calcAndUpdateUsage.mockImplementation(async (_sid: string, _state: SessionState, emit: (e: string, p: Record<string, unknown>) => void) => {
      emit('usage.updated', { inputTokens: 5, outputTokens: 7 })
      return { inputTokens: 5, outputTokens: 7 }
    })
    captured = undefined
    vi.spyOn(ompSessionManager, 'ensureSession').mockResolvedValue()
    vi.spyOn(ompSessionManager, 'setHandler').mockImplementation((_id: string, handler: (frame: Frame) => void) => {
      captured = handler
    })
    vi.spyOn(ompSessionManager, 'clearHandler').mockImplementation(() => {})
    vi.spyOn(ompSessionManager, 'prompt').mockReturnValue(true)
    vi.spyOn(ompSessionManager, 'abort').mockReturnValue(true)
  })

  function freshState(): SessionState {
    return { messages: [], isWorking: false, events: [], queue: [] }
  }

  it('maps a full assistant + tool turn onto /chat-run events and DB rows', async () => {
    const { emitted, nsp, socket } = makeHarness()
    const sessionMap = new Map<string, SessionState>([['sid', freshState()]])
    const dequeue = vi.fn()

    const run = handleOmpRun(
      nsp, socket,
      { input: 'hi there', session_id: 'sid' },
      'default', sessionMap,
      async () => freshState(),
      dequeue,
    )

    await vi.waitFor(() => expect(captured).toBeDefined())
    const emit = captured!

    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } })
    emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] }, assistantMessageEvent: { type: 'text_delta', delta: ' there' } })
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello there' }],
        usage: { input: 10, output: 5, totalTokens: 1234 },
        stopReason: 'toolUse',
      },
    })
    emit({ type: 'tool_execution_start', toolCallId: 'tool_1', toolName: 'bash', args: { command: 'ls -la' } })
    emit({ type: 'tool_execution_end', toolCallId: 'tool_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'README.md' }], isError: false }, isError: false })
    emit({ type: 'agent_end', messages: [] })

    await run

    // run.started once
    expect(eventsNamed(emitted, 'run.started')).toHaveLength(1)

    // streaming deltas accumulate cumulative output
    const deltas = eventsNamed(emitted, 'message.delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].payload.delta).toBe('Hello')
    expect(deltas[0].payload.output).toBe('Hello')
    expect(deltas[1].payload.delta).toBe(' there')
    expect(deltas[1].payload.output).toBe('Hello there')

    // tool lifecycle
    const started = eventsNamed(emitted, 'tool.started')
    expect(started).toHaveLength(1)
    expect(started[0].payload.name).toBe('bash')
    expect(started[0].payload.tool_call_id).toBe('tool_1')
    expect(started[0].payload.arguments).toBe(JSON.stringify({ command: 'ls -la' }))
    const completed = eventsNamed(emitted, 'tool.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].payload.tool_call_id).toBe('tool_1')
    expect(completed[0].payload.output).toBe('README.md')

    // terminal run.completed carries usage + omp-reported context tokens
    const done = eventsNamed(emitted, 'run.completed')
    expect(done).toHaveLength(1)
    expect(done[0].payload.run_id).toBeTruthy()
    expect(done[0].payload.output).toBe('Hello there')
    expect(done[0].payload.inputTokens).toBe(5)
    expect(done[0].payload.outputTokens).toBe(7)
    expect(done[0].payload.contextTokens).toBe(1234)
    expect(eventsNamed(emitted, 'run.failed')).toHaveLength(0)

    // session is released after completion
    const state = sessionMap.get('sid')!
    expect(state.isWorking).toBe(false)
    expect(state.runId).toBeUndefined()

    // persistence: user msg, assistant text flush, tool-call row, tool-result row
    const roles = mocks.addMessage.mock.calls.map(call => (call[0] as { role: string }).role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    expect(roles).toContain('tool')
    expect(mocks.updateSessionStats).toHaveBeenCalledWith('sid')
    expect(mocks.updateUsage).toHaveBeenCalledWith('sid', expect.objectContaining({ inputTokens: 5, outputTokens: 7 }))
  })

  it('emits run.failed when omp rejects the prompt', async () => {
    const { emitted, nsp, socket } = makeHarness()
    const sessionMap = new Map<string, SessionState>([['sid', freshState()]])

    const run = handleOmpRun(
      nsp, socket,
      { input: 'go', session_id: 'sid' },
      'default', sessionMap,
      async () => freshState(),
      vi.fn(),
    )
    await vi.waitFor(() => expect(captured).toBeDefined())
    captured!({ type: 'response', command: 'prompt', success: false, error: 'no model configured' })
    await run

    const failed = eventsNamed(emitted, 'run.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].payload.error).toBe('no model configured')
    expect(sessionMap.get('sid')!.isWorking).toBe(false)
  })

  it('fails fast when omp cannot start', async () => {
    const { emitted, nsp, socket } = makeHarness()
    const sessionMap = new Map<string, SessionState>([['sid', freshState()]])
    vi.spyOn(ompSessionManager, 'ensureSession').mockRejectedValue(new Error('omp not found on PATH'))

    await handleOmpRun(
      nsp, socket,
      { input: 'go', session_id: 'sid' },
      'default', sessionMap,
      async () => freshState(),
      vi.fn(),
    )

    const failed = eventsNamed(emitted, 'run.failed')
    expect(failed).toHaveLength(1)
    expect(String(failed[0].payload.error)).toContain('omp not found on PATH')
    expect(sessionMap.get('sid')!.isWorking).toBe(false)
  })
})
