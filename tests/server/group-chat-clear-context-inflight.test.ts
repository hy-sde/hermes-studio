import { describe, expect, it, vi } from 'vitest'

import { AgentClients, updateRoomTotalTokensForCurrentGeneration } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

function makeServerHarness() {
  let currentSeed = 'seed-1'
  const roomEmit = vi.fn()
  const socketEmit = vi.fn()
  const room = {
    hasOnlineMember: vi.fn(() => true),
    getOnlineMemberBySocketId: vi.fn((socketId: string) => ({
      userId: socketId === 'agent-socket' ? 'agent-1' : 'human-1',
      name: socketId === 'agent-socket' ? 'Worker' : 'Human',
      source: socketId === 'agent-socket' ? 'agent' : 'human',
    })),
  }
  const server = Object.create(GroupChatServer.prototype) as any
  server.rooms = new Map([['room-1', room]])
  server.socketRequestedSourceMap = new Map([['agent-socket', 'agent'], ['human-socket', 'human']])
  server.socketUserMap = new Map([['agent-socket', 'agent-1'], ['human-socket', 'human-1']])
  server.userInfoMap = new Map([['agent-1', { name: 'Worker', description: '' }], ['human-1', { name: 'Human', description: '' }]])
  server.typingState = new Map()
  server.contextStatusState = new Map()
  server.agentClients = { processMentions: vi.fn(async () => undefined) }
  server.storage = {
    getRoom: vi.fn(() => ({ sessionSeed: currentSeed })),
    saveMessageAndRefreshRoom: vi.fn((msg: any) => ({ message: msg, totalTokens: 123 })),
    updateRoomTotalTokens: vi.fn(),
  }
  server.nsp = { to: vi.fn(() => ({ emit: roomEmit })) }
  const socket: any = {
    id: 'agent-socket',
    to: vi.fn(() => ({ emit: socketEmit })),
  }

  return {
    server,
    socket,
    roomEmit,
    socketEmit,
    setSeed: (value: string) => { currentSeed = value },
  }
}

describe('group chat clear-context in-flight generation guards', () => {
  it('blocks stale direct total-token persistence captured before clear-context rotation', () => {
    let currentSeed = 'seed-2'
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: currentSeed })),
      updateRoomTotalTokens: vi.fn(),
    }

    expect(updateRoomTotalTokensForCurrentGeneration(storage, 'room-1', 999, 'seed-1')).toBe(false)
    expect(storage.updateRoomTotalTokens).not.toHaveBeenCalled()
  })

  it('allows current-generation direct total-token persistence after clear-context rotation', () => {
    let currentSeed = 'seed-2'
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: currentSeed })),
      updateRoomTotalTokens: vi.fn(),
    }

    expect(updateRoomTotalTokensForCurrentGeneration(storage, 'room-1', 321, 'seed-2')).toBe(true)
    expect(storage.updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 321)
  })

  it('drops old-generation agent output after clear-context instead of persisting or emitting it', () => {
    const { server, socket, roomEmit, socketEmit, setSeed } = makeServerHarness()
    const ack = vi.fn()

    setSeed('seed-2')

    server.handleMessage(socket, {
      roomId: 'room-1',
      id: 'msg-old',
      role: 'assistant',
      content: 'stale reply',
      sessionSeed: 'seed-1',
    }, ack)
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'stream-old',
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionSeed: 'seed-1',
    })
    server.handleMessageStreamDelta(socket, {
      roomId: 'room-1',
      id: 'stream-old',
      delta: 'stale delta',
      sessionSeed: 'seed-1',
    })
    server.handleMessageReasoningDelta(socket, {
      roomId: 'room-1',
      id: 'stream-old',
      delta: 'stale reasoning',
      sessionSeed: 'seed-1',
    })
    server.handleMessageStreamEnd(socket, {
      roomId: 'room-1',
      id: 'stream-old',
      sessionSeed: 'seed-1',
    })
    server.handleTyping(socket, {
      roomId: 'room-1',
      sessionSeed: 'seed-1',
    })
    server.handleStopTyping(socket, {
      roomId: 'room-1',
      sessionSeed: 'seed-1',
    })
    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 999,
      sessionSeed: 'seed-1',
    })
    server.handleApprovalRequested(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      approval_id: 'approval-old',
      command: 'rm -rf /',
      description: 'stale approval',
      sessionSeed: 'seed-1',
    })
    server.handleApprovalResolved(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      approval_id: 'approval-old',
      choice: 'deny',
      sessionSeed: 'seed-1',
    })

    expect(server.storage.saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(server.storage.updateRoomTotalTokens).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
    expect(socketEmit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ dropped: true, staleGeneration: true }))
  })

  it('allows current-generation agent output after clear-context rotation', () => {
    const { server, socket, roomEmit, socketEmit, setSeed } = makeServerHarness()
    const ack = vi.fn()

    setSeed('seed-2')

    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'stream-new',
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionSeed: 'seed-2',
    })
    server.handleMessageStreamDelta(socket, {
      roomId: 'room-1',
      id: 'stream-new',
      delta: 'fresh delta',
      sessionSeed: 'seed-2',
    })
    server.handleMessageReasoningDelta(socket, {
      roomId: 'room-1',
      id: 'stream-new',
      delta: 'fresh reasoning',
      sessionSeed: 'seed-2',
    })
    server.handleMessageStreamEnd(socket, {
      roomId: 'room-1',
      id: 'stream-new',
      sessionSeed: 'seed-2',
    })
    server.handleTyping(socket, {
      roomId: 'room-1',
      sessionSeed: 'seed-2',
    })
    server.handleStopTyping(socket, {
      roomId: 'room-1',
      sessionSeed: 'seed-2',
    })
    server.handleMessage(socket, {
      roomId: 'room-1',
      id: 'msg-new',
      role: 'assistant',
      content: 'fresh reply',
      sessionSeed: 'seed-2',
    }, ack)
    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 321,
      sessionSeed: 'seed-2',
    })
    server.handleApprovalRequested(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      approval_id: 'approval-new',
      command: 'echo hi',
      description: 'fresh approval',
      sessionSeed: 'seed-2',
    })
    server.handleApprovalResolved(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      approval_id: 'approval-new',
      choice: 'once',
      sessionSeed: 'seed-2',
    })

    expect(server.storage.saveMessageAndRefreshRoom).toHaveBeenCalledOnce()
    expect(server.storage.updateRoomTotalTokens).toHaveBeenCalledWith('room-1', 321)
    expect(roomEmit).toHaveBeenCalledWith('message_stream_start', expect.objectContaining({ id: 'stream-new', roomId: 'room-1' }))
    expect(roomEmit).toHaveBeenCalledWith('message_stream_delta', { roomId: 'room-1', id: 'stream-new', delta: 'fresh delta' })
    expect(roomEmit).toHaveBeenCalledWith('message_reasoning_delta', { roomId: 'room-1', id: 'stream-new', delta: 'fresh reasoning' })
    expect(roomEmit).toHaveBeenCalledWith('message_stream_end', { roomId: 'room-1', id: 'stream-new' })
    expect(roomEmit).toHaveBeenCalledWith('message', expect.objectContaining({ id: 'msg-new', content: 'fresh reply' }))
    expect(roomEmit).toHaveBeenCalledWith('room_updated', { roomId: 'room-1', totalTokens: 123 })
    expect(roomEmit).toHaveBeenCalledWith('room_updated', { roomId: 'room-1', totalTokens: 321 })
    expect(roomEmit).toHaveBeenCalledWith('approval.requested', expect.objectContaining({ roomId: 'room-1', approval_id: 'approval-new', agentName: 'Worker' }))
    expect(roomEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({ roomId: 'room-1', approval_id: 'approval-new', choice: 'once', agentName: 'Worker' }))
    expect(socketEmit).toHaveBeenCalledWith('typing', { roomId: 'room-1', userId: 'agent-1', userName: 'Worker' })
    expect(socketEmit).toHaveBeenCalledWith('stop_typing', { roomId: 'room-1', userId: 'agent-1' })
    expect(socketEmit).toHaveBeenCalledWith('context_status', { roomId: 'room-1', agentName: 'Worker', status: 'replying' })
    expect(ack).toHaveBeenCalledWith({ id: 'msg-new' })
  })

  it('drops queued mentions captured before clear-context so they do not start new runs', async () => {
    let currentSeed = 'seed-1'
    let releaseFirstRun: (() => void) | undefined
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    const replyToMention = vi.fn()
      .mockImplementationOnce(() => firstRunDone)
      .mockResolvedValue(undefined)
    const agent: any = {
      name: 'Worker',
      agentId: 'agent-1',
      replyToMention,
      emitContextStatus: vi.fn(),
      cancelActiveRun: vi.fn(async () => undefined),
      setStorage: vi.fn(),
    }

    const clients = new AgentClients() as any
    clients.rooms = new Map([['room-1', new Map([['agent-1', agent]])]])
    clients.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: currentSeed })),
    })

    await clients.processMentions('room-1', {
      content: '@Worker first',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      senderKind: 'user',
    })
    expect(replyToMention).toHaveBeenCalledTimes(1)

    await clients.processMentions('room-1', {
      content: '@Worker second',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 2,
      senderKind: 'user',
    })
    expect((clients as any)._mentionQueue.get('room-1:Worker')).toHaveLength(1)

    currentSeed = 'seed-2'
    releaseFirstRun?.()

    await vi.waitFor(() => {
      expect(replyToMention).toHaveBeenCalledTimes(1)
      expect((clients as any)._mentionQueue.has('room-1:Worker')).toBe(false)
    })
  })
})
