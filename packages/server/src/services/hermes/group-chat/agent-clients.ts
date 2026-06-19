import { io, Socket } from 'socket.io-client'
import { randomBytes } from 'crypto'
import { getToken } from '../../../services/auth'
import { logger } from '../../../services/logger'
import { updateUsage } from '../../../db/hermes/usage-store'
import { countTokens } from '../../../lib/context-compressor'
import { AgentBridgeClient, type AgentBridgeContextEstimate, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { convertContentBlocksForAgent, isContentBlockArray } from '../run-chat/content-blocks'
import { resolveBridgeRunModelConfig } from '../run-chat/model-config'
import type { ContentBlock } from '../run-chat/types'
import type { StoredMessage } from '../context-engine/types'
import { buildProjectedGroupChatHistory, projectGroupChatMessage } from './context-projection'
import { sliceGroupMessagesForSnapshotTail } from './group-message-ordering'
import {
    defaultMentionRoutingScope,
    resolveMentionRouting,
    stripMentionAddressBlockFromInput,
    type MentionSenderKind,
} from './mention-routing'

export const GROUP_CHAT_AGENT_SOCKET_SECRET = randomBytes(32).toString('hex')

export function normalizeRoomGeneration(sessionSeed: unknown): string {
    return String(sessionSeed || '0')
}

export function getRoomGeneration(storage: { getRoom?: (roomId: string) => { sessionSeed?: unknown } | undefined } | null | undefined, roomId: string): string {
    return normalizeRoomGeneration(storage?.getRoom?.(roomId)?.sessionSeed)
}

export function roomGenerationMatches(
    storage: { getRoom?: (roomId: string) => { sessionSeed?: unknown } | undefined } | null | undefined,
    roomId: string,
    sessionSeed: unknown,
): boolean {
    return getRoomGeneration(storage, roomId) === normalizeRoomGeneration(sessionSeed)
}

export function updateRoomTotalTokensForCurrentGeneration(
    storage: {
        getRoom?: (roomId: string) => { sessionSeed?: unknown } | undefined
        updateRoomTotalTokens?: (roomId: string, totalTokens: number) => void
    } | null | undefined,
    roomId: string,
    totalTokens: number,
    sessionSeed: unknown,
): boolean {
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) return false
    if (!roomGenerationMatches(storage, roomId, sessionSeed)) return false
    storage?.updateRoomTotalTokens?.(roomId, totalTokens)
    return true
}

// ─── Types ────────────────────────────────────────────────────

interface AgentConfig {
    agentId?: string
    profile: string
    name: string
    description: string
    invited: number
}

interface MessageData {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
}

type MentionMessage = {
    messageId?: string
    content: string
    senderName: string
    senderId: string
    timestamp: number
    input?: string | ContentBlock[]
    mentionDepth?: number
    senderKind: MentionSenderKind
    mentionRouting?: {
        targetNames: string[]
        scope: 'all' | 'explicit' | 'none'
        addressBlock?: {
            range: { startIndex: number; endIndex: number }
            textBlockIndex?: number
        } | null
    }
}

export function mentionMessageToStoredContextMessage(roomId: string, msg: MentionMessage): StoredMessage {
    return {
        id: msg.messageId || '',
        roomId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        timestamp: msg.timestamp,
        role: msg.senderKind === 'agent' ? 'assistant' : 'user',
    }
}

type GroupEstimateMessage = { role: 'user' | 'assistant'; content: string }
export type GroupModelContext = { model: string; provider: string }

interface BridgeContextCache {
    fixedContextTokens: number
    instructions?: string
    systemPromptTokens?: number
    toolTokens?: number
    systemPromptChars?: number
    toolCount?: number
    toolNames?: string[]
    profile?: string
    model?: string
    provider?: string
}

type RoomRunGeneration = {
    sessionSeed: string
    sessionId: string
}

export async function resolveGroupAgentModelContext(profile: string): Promise<GroupModelContext> {
    return resolveBridgeRunModelConfig({ profile })
}

export function estimateGroupHistoryMessageTokens(history: Array<{ content?: unknown }>): number {
    return history.reduce((sum, message) => sum + countTokens(String(message.content || '')), 0)
}

export function groupContextTokensWithFixedOverhead(
    fixedContextTokens: number | null | undefined,
    history: Array<{ content?: unknown }>,
): number | undefined {
    if (typeof fixedContextTokens !== 'number' || !Number.isFinite(fixedContextTokens) || fixedContextTokens < 0) {
        return undefined
    }
    return Math.floor(fixedContextTokens) + estimateGroupHistoryMessageTokens(history)
}

export function isGroupBridgeContextCacheCompatible(
    cache: { model?: string; provider?: string } | null | undefined,
    modelContext: GroupModelContext,
): boolean {
    if (!cache) return false
    if (modelContext.model && cache.model !== modelContext.model) return false
    if (modelContext.provider && cache.provider !== modelContext.provider) return false
    return true
}

export function groupBridgeReasoningDeltaFromEvent(event: Record<string, unknown>): string | null {
    if (String(event.event || '') !== 'reasoning.delta') return null
    const text = String(event.text || '')
    return text ? text : null
}

interface MemberData {
    id: string
    name: string
    joinedAt: number
}

interface JoinResult {
    roomId: string
    roomName: string
    members: MemberData[]
    messages: MessageData[]
    rooms: string[]
}

export interface AgentEventHandler {
    onMessage?: (data: { roomId: string; msg: MessageData }) => void
    onTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onStopTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onMemberJoined?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
    onMemberLeft?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
}

// ─── Agent Client (single connection) ─────────────────────────

class AgentClient {
    readonly agentId: string
    readonly profile: string
    readonly name: string
    readonly description: string
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private contextEngine: any = null
    private storage: any = null
    private activeRoomRuns = new Map<string, RoomRunGeneration>()
    private pendingToolCallIds = new Map<string, string[]>()
    private pendingToolBaseIds = new Map<string, string>()
    private bridgeContextCache = new Map<string, BridgeContextCache>()

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}) {
        this.agentId = config.agentId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.profile = config.profile
        this.name = config.name
        this.description = config.description
        this.handlers = handlers
    }

    get connected(): boolean {
        return this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.socket?.id
    }

    setContextEngine(engine: any): void {
        this.contextEngine = engine
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    async connect(port?: number): Promise<void> {
        const actualPort = port ?? parseInt(process.env.PORT || '8648', 10)
        const token = await getToken()

        this.socket = io(`http://127.0.0.1:${actualPort}/group-chat`, {
            auth: {
                token: token || undefined,
                userId: this.agentId,
                name: this.name,
                description: this.description,
                source: 'agent',
                agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
            randomizationFactor: 0.5,
            timeout: 30000,
        })

        this.bindEvents()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

            this.socket!.on('connect', () => {
                clearTimeout(timeout)
                logger.debug(`[AgentClient] ${this.name} connected, socket id: ${this.socket!.id}`)
                resolve()
            })

            this.socket!.on('connect_error', (err) => {
                clearTimeout(timeout)
                logger.error(err, `[AgentClient] ${this.name} connect_error`)
                reject(err)
            })
        })
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
            this.joinedRooms.clear()
            this.activeRoomRuns.clear()
            this.bridgeContextCache.clear()
        }
    }

    async joinRoom(roomId: string): Promise<JoinResult> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('join', { roomId }, (res: JoinResult | { error: string }) => {
                if ('error' in res) {
                    reject(new Error(res.error))
                } else {
                    this.joinedRooms.add(roomId)
                    resolve(res)
                }
            })
        })
    }

    sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, sessionSeed?: string): Promise<string> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('message', { roomId, content, id: messageId, ...extra, ...(sessionSeed ? { sessionSeed } : {}) }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    reject(new Error(res.error))
                } else {
                    resolve(res.id!)
                }
            })
        })
    }

    startTyping(roomId: string, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('typing', { roomId, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    stopTyping(roomId: string, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('stop_typing', { roomId, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('context_status', { roomId, agentName: this.name, status, ...extra, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    emitApprovalRequested(roomId: string, payload: Record<string, unknown>, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('approval.requested', { roomId, agentName: this.name, ...payload, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    emitApprovalResolved(roomId: string, payload: Record<string, unknown>, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('approval.resolved', { roomId, agentName: this.name, ...payload, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    async interrupt(roomId: string): Promise<void> {
        const activeRun = this.activeRoomRuns.get(roomId)
        const sessionSeed = activeRun?.sessionSeed || getRoomGeneration(this.storage, roomId)
        const sessionId = activeRun?.sessionId || groupBridgeSessionId(roomId, this.profile, this.name, sessionSeed)
        await new AgentBridgeClient().interrupt(sessionId, 'Interrupted by group chat user', this.profile)
        this.stopTyping(roomId, sessionSeed)
        this.emitContextStatus(roomId, 'ready', undefined, sessionSeed)
        this.activeRoomRuns.delete(roomId)
    }

    async cancelActiveRun(roomId: string): Promise<void> {
        const activeRun = this.activeRoomRuns.get(roomId)
        if (!activeRun) return
        try {
            await new AgentBridgeClient().interrupt(activeRun.sessionId, 'Interrupted by group chat clear-context', this.profile)
        } finally {
            try { this.stopTyping(roomId, activeRun.sessionSeed) } catch { /* ignore */ }
            try { this.emitContextStatus(roomId, 'ready', undefined, activeRun.sessionSeed) } catch { /* ignore */ }
            this.activeRoomRuns.delete(roomId)
        }
    }

    emitMessageStreamStart(roomId: string, messageId: string, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('message_stream_start', {
            roomId,
            id: messageId,
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            timestamp: Date.now(),
            ...(sessionSeed ? { sessionSeed } : {}),
        })
    }

    emitMessageStreamDelta(roomId: string, messageId: string, delta: string, sessionSeed?: string): void {
        if (!delta) return
        this.ensureConnected()
        this.socket!.emit('message_stream_delta', { roomId, id: messageId, delta, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    emitMessageReasoningDelta(roomId: string, messageId: string, delta: string, sessionSeed?: string): void {
        if (!delta) return
        this.ensureConnected()
        this.socket!.emit('message_reasoning_delta', { roomId, id: messageId, delta, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    emitMessageStreamEnd(roomId: string, messageId: string, sessionSeed?: string): void {
        this.ensureConnected()
        this.socket!.emit('message_stream_end', { roomId, id: messageId, ...(sessionSeed ? { sessionSeed } : {}) })
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
    }

    private finiteToken(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.floor(value)
            : undefined
    }

    private persistRoomTotalTokensIfCurrentGeneration(
        roomId: string,
        totalTokens: number,
        sessionSeed: string,
        source: 'build' | 'final',
    ): boolean {
        const persisted = updateRoomTotalTokensForCurrentGeneration(this.storage, roomId, totalTokens, sessionSeed)
        if (!persisted) {
            logger.debug(
                `[AgentClients] ${this.name}: skipped stale ${source} totalTokens write for room ${roomId}: captured=${normalizeRoomGeneration(sessionSeed)} current=${getRoomGeneration(this.storage, roomId)}`,
            )
        }
        return persisted
    }

    private cacheBridgeContext(
        sessionId: string,
        data: Record<string, unknown> | AgentBridgeContextEstimate,
        instructions?: string,
        modelContext: GroupModelContext = { model: '', provider: '' },
    ): void {
        const fixedContextTokens = this.finiteToken(data.fixed_context_tokens)
        if (fixedContextTokens == null) return
        this.bridgeContextCache.set(sessionId, {
            fixedContextTokens,
            instructions,
            systemPromptTokens: this.finiteToken(data.system_prompt_tokens),
            toolTokens: this.finiteToken(data.tool_tokens),
            systemPromptChars: this.finiteToken(data.system_prompt_chars),
            toolCount: this.finiteToken(data.tool_count),
            toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
            profile: typeof data.profile === 'string' ? data.profile : undefined,
            model: typeof data.model === 'string' ? data.model : modelContext.model || undefined,
            provider: typeof data.provider === 'string' ? data.provider : modelContext.provider || undefined,
        })
    }

    private estimateHistoryMessageTokens(history: GroupEstimateMessage[]): number {
        return estimateGroupHistoryMessageTokens(history)
    }

    private estimateWithCachedBridgeContext(sessionId: string, history: GroupEstimateMessage[], instructions: string | undefined, modelContext: GroupModelContext): number | undefined {
        const cache = this.bridgeContextCache.get(sessionId)
        if (!cache) return undefined
        if (cache.instructions !== instructions) return undefined
        if (!isGroupBridgeContextCacheCompatible(cache, modelContext)) return undefined
        return groupContextTokensWithFixedOverhead(cache.fixedContextTokens, history)
    }

    private async estimateGroupContextTokens(
        roomId: string,
        sessionId: string,
        bridge: AgentBridgeClient,
        history: GroupEstimateMessage[],
        instructions: string | undefined,
        modelContext: GroupModelContext,
        phase: string,
    ): Promise<number | undefined> {
        const cachedTokens = this.estimateWithCachedBridgeContext(sessionId, history, instructions, modelContext)
        if (cachedTokens != null) {
            logger.info({
                roomId,
                agentName: this.name,
                profile: this.profile,
                sessionId,
                messages: history.length,
                fixedContextTokens: this.bridgeContextCache.get(sessionId)?.fixedContextTokens,
                messageTokens: cachedTokens - (this.bridgeContextCache.get(sessionId)?.fixedContextTokens || 0),
                fullContextTokens: cachedTokens,
                phase,
                source: 'cache',
            }, '[GroupChat] full context estimate')
            return cachedTokens
        }

        const estimate = await bridge.contextEstimate(
            sessionId,
            history,
            instructions,
            this.profile,
            {
                ...(modelContext.model ? { model: modelContext.model } : {}),
                ...(modelContext.provider ? { provider: modelContext.provider } : {}),
            },
        )
        this.cacheBridgeContext(sessionId, estimate, instructions, modelContext)
        const totalTokens = Number(estimate.token_count || 0)
        logger.info({
            roomId,
            agentName: this.name,
            profile: this.profile,
            sessionId,
            messages: estimate.message_count,
            toolCount: estimate.tool_count,
            systemPromptChars: estimate.system_prompt_chars,
            fixedContextTokens: estimate.fixed_context_tokens,
            fullContextTokens: estimate.token_count,
            phase,
            source: 'bridge',
        }, '[GroupChat] full context estimate')
        return Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : undefined
    }

    private ensureConnected(): void {
        if (!this.socket?.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    // ─── Hermes Agent Bridge Integration ───────────────────────

    /**
     * Handle an @mention from the server side.
     * Called by AgentClients.processMentions() — no socket round-trip needed.
     * onStatus is called to report context compression progress.
     */
    async replyToMention(
        roomId: string,
        msg: MentionMessage,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        logger.debug({
            roomId,
            agentName: this.name,
            senderName: msg.senderName,
            senderKind: msg.senderKind,
            mentionDepth: Math.max(0, msg.mentionDepth || 0),
            messageId: msg.messageId,
            targetNames: msg.mentionRouting?.targetNames || [],
            scope: msg.mentionRouting?.scope || 'none',
        }, '[GroupChat] agent mention reply start')
        const runMessageId = groupMessageId(roomId, this.profile, this.name)
        const sessionSeed = getRoomGeneration(this.storage, roomId)
        const sessionId = groupBridgeSessionId(roomId, this.profile, this.name, sessionSeed)
        const activeRun: RoomRunGeneration = { sessionSeed, sessionId }
        let partIndex = 0
        let streamMessageId = groupMessagePartId(runMessageId, partIndex)
        let currentContent = ''
        let totalContent = ''
        let reasoningContent = ''
        let streamStarted = false
        try {
            this.activeRoomRuns.set(roomId, activeRun)
            // Notify room that agent is typing
            this.startTyping(roomId, sessionSeed)

            // Build compressed context if context engine is available
            let conversationHistory: Array<{ role: string; content: string }> = []
            let instructions: string | undefined
            const bridge = new AgentBridgeClient()
            const modelContext = await resolveGroupAgentModelContext(this.profile)

            if (this.contextEngine && this.storage) {
                try {
                    logger.debug(`[AgentClients] ${this.name}: building context...`)
                    // Get room members with descriptions for context
                    const roomMembers: Array<{ userId: string; name: string; description: string }> = this.storage.getRoomMembers(roomId) || []
                    const memberNames = roomMembers.map((m: any) => m.name)
                    const members = roomMembers.map((m: any) => ({ userId: m.userId, name: m.name, description: m.description }))

                    // Get room compression config
                    const roomInfo = this.storage.getRoom(roomId)
                    const compression = roomInfo ? {
                        triggerTokens: roomInfo.triggerTokens,
                        maxHistoryTokens: roomInfo.maxHistoryTokens,
                        tailMessageCount: roomInfo.tailMessageCount,
                    } : undefined

                    const ctx = await this.contextEngine.buildContext({
                        roomId,
                        agentId: this.agentId,
                        agentName: this.name,
                        agentDescription: this.description,
                        agentSocketId: this.socket?.id || '',
                        roomName: roomId,
                        memberNames,
                        members,
                        upstream: '',
                        apiKey: null,
                        currentMessage: mentionMessageToStoredContextMessage(roomId, msg),
                        compression,
                        profile: this.profile,
                        onProgress: (event: { status: 'compressing'; messageCount: number; tokenCount: number }) => {
                            onStatus?.('compressing', {
                                messageCount: event.messageCount,
                                totalTokens: event.tokenCount,
                            })
                        },
                        contextTokenEstimator: async (history: Array<{ role: 'user' | 'assistant'; content: string }>, estimateInstructions: string) => {
                            return this.estimateGroupContextTokens(
                                roomId,
                                sessionId,
                                bridge,
                                history,
                                estimateInstructions,
                                modelContext,
                                'build',
                            )
                        },
                    })
                    conversationHistory = ctx.conversationHistory
                    instructions = ctx.instructions
                    if (typeof ctx.meta.contextTokenEstimate === 'number' && Number.isFinite(ctx.meta.contextTokenEstimate)) {
                        this.persistRoomTotalTokensIfCurrentGeneration(roomId, ctx.meta.contextTokenEstimate, sessionSeed, 'build')
                        onStatus?.('replying', { totalTokens: ctx.meta.contextTokenEstimate })
                    }
                    logger.debug(`[AgentClients] ${this.name}: context built — historyLen=${conversationHistory.length}, meta=%j`, ctx.meta)
                    onStatus?.('replying')
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: context engine failed: ${err.message}`)
                    onStatus?.('replying')
                    // Degrade: continue without context
                }
            }

            // Keep routing explicit while removing only the mention tokens that
            // selected this agent. This avoids making @all look like an
            // instruction for the model to fan out another routing cycle.
            const routedPrefix = msg.mentionRouting?.scope === 'all'
                ? `群聊系统：这条消息通过 @all 提及所有 agent，你是其中之一，请直接回复。`
                : `群聊系统：这条消息已经提及你（${this.name}），请直接回复；即使消息同时提及其他成员，也不要因此输出空回复。`
            const rawInput = msg.input ?? msg.content
            const strippedInput = stripMentionAddressBlockFromInput(rawInput, msg.mentionRouting?.addressBlock)
            const input = isContentBlockArray(strippedInput)
                ? [{ type: 'text' as const, text: `${routedPrefix}\n\n原始消息：` }, ...strippedInput]
                : `${routedPrefix}\n\n原始消息：${String(strippedInput || msg.content)}`
            const runPrompt = 'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.'
            instructions = instructions ? `${runPrompt}\n${instructions}` : runPrompt
            const bridgeInput: AgentBridgeMessage = isContentBlockArray(input)
                ? await convertContentBlocksForAgent(input)
                : input
            const flushedAssistantParts = new Set<string>()
            let lastChunk: AgentBridgeOutput | null = null
            const started = await bridge.chat(
                sessionId,
                bridgeInput,
                conversationHistory,
                instructions,
                this.profile,
                {
                    ...(modelContext.model ? { model: modelContext.model } : {}),
                    ...(modelContext.provider ? { provider: modelContext.provider } : {}),
                    source: 'api_server',
                },
            )

            this.emitMessageStreamStart(roomId, streamMessageId, sessionSeed)
            streamStarted = true
            for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 120000 })) {
                lastChunk = chunk
                reasoningContent += await this.recordBridgeEvents(roomId, sessionId, instructions, modelContext, chunk, () => streamMessageId, async () => {
                    const toolBaseId = streamMessageId
                    if (currentContent.trim()) {
                        await this.sendMessage(roomId, currentContent, streamMessageId, {
                            role: 'assistant',
                            mentionDepth: nextMentionDepth(msg),
                            reasoning: reasoningContent || null,
                            reasoning_content: reasoningContent || null,
                        }, sessionSeed)
                        flushedAssistantParts.add(streamMessageId)
                        currentContent = ''
                    }
                    this.emitMessageStreamEnd(roomId, toolBaseId, sessionSeed)
                    partIndex += 1
                    streamMessageId = groupMessagePartId(runMessageId, partIndex)
                    this.emitMessageStreamStart(roomId, streamMessageId, sessionSeed)
                    streamStarted = true
                    return toolBaseId
                }, sessionSeed)
                if (chunk.delta) {
                    currentContent += chunk.delta
                    totalContent += chunk.delta
                    this.emitMessageStreamDelta(roomId, streamMessageId, chunk.delta, sessionSeed)
                }
            }

            if (lastChunk?.status === 'error') {
                logger.error(`[AgentClients] ${this.name}: bridge response failed: ${lastChunk.error || 'unknown error'}`)
                await this.sendAgentErrorMessage(roomId, streamMessageId, lastChunk.error || 'Run failed', msg, reasoningContent, sessionSeed)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionSeed)
                this.stopTyping(roomId, sessionSeed)
                onStatus?.('ready')
                return
            }

            if (!totalContent) {
                currentContent = extractBridgeFinalText(lastChunk)
                totalContent = currentContent
            }
            recordBridgeUsage(roomId, this.profile, lastChunk?.result)
            logger.debug(`[AgentClients] ${this.name}: bridge response completed, content length=${totalContent.length}`)
            if (currentContent) {
                this.stopTyping(roomId, sessionSeed)
                await this.sendMessage(roomId, currentContent, streamMessageId, {
                    role: 'assistant',
                    mentionDepth: nextMentionDepth(msg),
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionSeed)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionSeed)
                await this.refreshRoomFullContextEstimate(roomId, sessionId, bridge, sessionSeed, instructions, modelContext)
                onStatus?.('ready')
                return
            }
            logger.warn(`[AgentClients] ${this.name}: bridge response completed without content`)
            this.emitMessageStreamEnd(roomId, streamMessageId, sessionSeed)
            this.stopTyping(roomId, sessionSeed)
            onStatus?.('ready')
        } catch (err: any) {
            logger.error(`[AgentClients] ${this.name}: error handling message: ${err.message}`)
            try {
                await this.sendAgentErrorMessage(roomId, streamMessageId, err, msg, reasoningContent, sessionSeed)
                if (streamStarted) this.emitMessageStreamEnd(roomId, streamMessageId, sessionSeed)
            } catch (sendErr: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to send error message: ${sendErr.message}`)
            }
            this.stopTyping(roomId, sessionSeed)
            onStatus?.('ready')
        } finally {
            if (this.activeRoomRuns.get(roomId)?.sessionId === sessionId) {
                this.activeRoomRuns.delete(roomId)
            }
        }
    }

    private async refreshRoomFullContextEstimate(
        roomId: string,
        sessionId: string,
        bridge: AgentBridgeClient,
        sessionSeed: string,
        instructions?: string,
        modelContext: GroupModelContext = { model: '', provider: '' },
    ): Promise<void> {
        if (!this.storage?.getMessagesForContext) return
        try {
            const history = this.buildRoomEstimateHistory(roomId)
            const cachedTokens = await this.estimateGroupContextTokens(
                roomId,
                sessionId,
                bridge,
                history,
                instructions,
                modelContext,
                'final',
            )
            if (cachedTokens == null || cachedTokens <= 0) return
            const rounded = Math.floor(cachedTokens)
            this.persistRoomTotalTokensIfCurrentGeneration(roomId, rounded, sessionSeed, 'final')
            this.emitContextStatus(roomId, 'replying', { totalTokens: rounded }, sessionSeed)
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to refresh final context estimate room=${roomId} agent=${this.name}: ${err.message}`)
        }
    }

    private buildRoomEstimateHistory(roomId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
        const messages: StoredMessage[] = this.storage?.getMessagesForContext?.(roomId) || []
        const snapshot = this.storage?.getContextSnapshot?.(roomId)
        if (snapshot?.summary) {
            const tail = sliceGroupMessagesForSnapshotTail(messages, snapshot.lastMessageId).messages
            return buildProjectedGroupChatHistory(snapshot.summary, tail, { agentId: this.agentId, socketId: this.socket?.id, name: this.name })
        }
        return messages.map((message: any) => this.mapRoomMessageForEstimate(message))
    }

    private mapRoomMessageForEstimate(message: any): { role: 'user' | 'assistant'; content: string } {
        return projectGroupChatMessage(message, { agentId: this.agentId, socketId: this.socket?.id, name: this.name })
    }

    private async sendAgentErrorMessage(
        roomId: string,
        messageId: string,
        error: unknown,
        sourceMsg: MentionMessage,
        reasoningContent = '',
        sessionSeed?: string,
    ): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error || 'Run failed')
        const content = detail.startsWith('Error:') ? detail : `Error: ${detail}`
        await this.sendMessage(roomId, content, messageId, {
            role: 'assistant',
            mentionDepth: nextMentionDepth(sourceMsg),
            finish_reason: 'error',
            reasoning: reasoningContent || null,
            reasoning_content: reasoningContent || null,
        }, sessionSeed)
    }

    private async recordBridgeEvents(
        roomId: string,
        sessionId: string,
        instructions: string | undefined,
        modelContext: GroupModelContext,
        chunk: AgentBridgeOutput,
        getCurrentMessageId: () => string,
        beforeToolStarted: () => Promise<string>,
        sessionSeed: string,
    ): Promise<string> {
        let reasoning = ''
        for (const ev of chunk.events || []) {
            const eventType = String((ev as any)?.event || '')
            if (eventType === 'bridge.context.ready') {
                this.cacheBridgeContext(sessionId, ev as Record<string, unknown>, instructions, modelContext)
            } else if (eventType === 'tool.started') {
                const toolBaseId = await beforeToolStarted()
                this.recordToolStarted(roomId, ev as Record<string, unknown>, toolBaseId, sessionSeed)
            } else if (eventType === 'tool.completed') {
                this.recordToolCompleted(roomId, ev as Record<string, unknown>, sessionSeed)
            } else if (eventType === 'approval.requested') {
                this.emitApprovalRequested(roomId, {
                    event: 'approval.requested',
                    approval_id: (ev as any).approval_id,
                    command: (ev as any).command,
                    description: (ev as any).description,
                    choices: Array.isArray((ev as any).choices) ? (ev as any).choices : undefined,
                    allow_permanent: (ev as any).allow_permanent,
                }, sessionSeed)
            } else if (eventType === 'approval.resolved') {
                this.emitApprovalResolved(roomId, {
                    event: 'approval.resolved',
                    approval_id: (ev as any).approval_id,
                    choice: (ev as any).choice,
                }, sessionSeed)
            } else {
                const text = groupBridgeReasoningDeltaFromEvent(ev as Record<string, unknown>)
                if (text) {
                    reasoning += text
                    this.emitMessageReasoningDelta(roomId, getCurrentMessageId(), text, sessionSeed)
                }
            }
        }
        return reasoning
    }

    private recordToolStarted(roomId: string, ev: Record<string, unknown>, runMessageId: string, sessionSeed: string): void {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const toolCallId = groupToolCallId(ev.tool_call_id, toolName, this.nextToolIndex(roomId, toolName))
        this.trackPendingToolCall(roomId, toolName, toolCallId)
        this.pendingToolBaseIds.set(toolCallId, runMessageId)
        const timestamp = Date.now()
        const rawArgs = ev.args ?? ev.arguments ?? ev.input ?? {}
        const args = normalizeToolArgs(rawArgs)
        const toolCall = {
            id: toolCallId,
            type: 'function',
            function: {
                name: toolName,
                arguments: JSON.stringify(args),
            },
        }
        const msg: MessageData & Record<string, any> = {
            id: `${runMessageId}_toolcall_${safeId(toolCallId)}`,
            roomId,
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            content: '',
            timestamp,
            role: 'assistant',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
        }
        this.sendMessage(roomId, '', msg.id, {
            role: 'assistant',
            tool_calls: msg.tool_calls,
            finish_reason: 'tool_calls',
            timestamp,
        }, sessionSeed).catch((err: any) => logger.warn(`[AgentClients] failed to record tool call: ${err.message}`))
    }

    private recordToolCompleted(roomId: string, ev: Record<string, unknown>, sessionSeed: string): void {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const rawId = String(ev.tool_call_id || '').trim()
        const toolCallId = rawId || this.takePendingToolCall(roomId, toolName) || groupToolCallId(null, toolName, this.nextToolIndex(roomId, toolName))
        const runMessageId = this.pendingToolBaseIds.get(toolCallId) || groupMessagePartId(groupMessageId(roomId, this.profile, this.name), 0)
        this.pendingToolBaseIds.delete(toolCallId)
        const output = bridgeToolOutput(ev)
        const timestamp = Date.now()
        const msg: MessageData & Record<string, any> = {
            id: `${runMessageId}_toolresult_${safeId(toolCallId)}_${Date.now()}`,
            roomId,
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            content: output,
            timestamp,
            role: 'tool',
            tool_call_id: toolCallId,
            tool_name: toolName || null,
        }
        this.sendMessage(roomId, output, msg.id, {
            role: 'tool',
            tool_call_id: toolCallId,
            tool_name: toolName || null,
            timestamp,
        }, sessionSeed).catch((err: any) => logger.warn(`[AgentClients] failed to record tool result: ${err.message}`))
    }

    private pendingToolKey(roomId: string, toolName: string): string {
        return `${roomId}::${toolName || 'tool'}`
    }

    private trackPendingToolCall(roomId: string, toolName: string, toolCallId: string): void {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key) || []
        list.push(toolCallId)
        this.pendingToolCallIds.set(key, list)
    }

    private takePendingToolCall(roomId: string, toolName: string): string | undefined {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key)
        if (!list?.length) return undefined
        const id = list.shift()
        if (list.length) this.pendingToolCallIds.set(key, list)
        else this.pendingToolCallIds.delete(key)
        return id
    }

    private nextToolIndex(roomId: string, toolName: string): number {
        const key = this.pendingToolKey(roomId, toolName)
        return (this.pendingToolCallIds.get(key)?.length || 0) + 1
    }

    private bindEvents(): void {
        const s = this.socket!

        s.on('typing', (data: any) => {
            this.handlers.onTyping?.(data)
        })

        s.on('stop_typing', (data: any) => {
            this.handlers.onStopTyping?.(data)
        })

        s.on('member_joined', (data: any) => {
            this.handlers.onMemberJoined?.(data)
        })

        s.on('member_left', (data: any) => {
            this.handlers.onMemberLeft?.(data)
        })

        // Auto rejoin rooms on reconnect
        s.io.on('reconnect', async () => {
            if (this._reconnecting) return
            this._reconnecting = true
            logger.info(`[AgentClients] ${this.name} reconnecting, rejoining ${this.joinedRooms.size} rooms...`)
            const rooms = Array.from(this.joinedRooms)
            for (const roomId of rooms) {
                try {
                    await this.joinRoom(roomId)
                } catch (err: any) {
                    logger.error(`[AgentClients] ${this.name} failed to rejoin room ${roomId}: ${err.message}`)
                }
            }
            this._reconnecting = false
        })
    }
}

function groupBridgeSessionId(roomId: string, profile: string, name: string, sessionSeed: string): string {
    const raw = `gc_${roomId}_${profile}_${name}_${sessionSeed || '0'}`
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
}

function groupMessageId(roomId: string, profile: string, name: string): string {
    const raw = `gcmsg_${safeId(roomId)}_${safeId(profile)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
}

function groupMessagePartId(runMessageId: string, partIndex: number): string {
    return `${safeId(runMessageId)}_part_${partIndex}`
}

function groupToolCallId(rawToolCallId: unknown, toolName: string, index: number): string {
    const raw = String(rawToolCallId || '').trim()
    if (raw) return raw
    return `cli_${safeId(toolName || 'tool')}_${Date.now()}_${index}`
}

function safeId(value: string): string {
    return String(value || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

function bridgeToolOutput(ev: Record<string, unknown>): string {
    const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ''
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
    if (!value) return {}
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value }
        } catch {
            return { value }
        }
    }
    return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function extractBridgeFinalText(chunk: AgentBridgeOutput | null): string {
    const result = chunk?.result as any
    const output = result?.final_response || chunk?.output || ''
    return typeof output === 'string' ? output.trim() : ''
}

function recordBridgeUsage(roomId: string, profile: string, result: unknown): void {
    const payload = result as any
    const usage = payload?.usage || payload?.response?.usage
    if (!usage) return
    updateUsage(roomId, {
        inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
        outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
        cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
        model: payload?.model || payload?.response?.model || '',
        profile,
    })
}

function logMentionQueueDrop(details: {
    roomId: string
    agentName: string
    reason: string
    droppedCount?: number
    messageId?: string
    queuedGeneration?: string
    currentGeneration?: string
}): void {
    logger.info(details, '[GroupChat] mention queue drop')
}

// ─── AgentClients (roomId -> agents) ──────────────────────────

export class AgentClients {
    private rooms = new Map<string, Map<string, AgentClient>>()
    private _contextEngine: any = null
    private _storage: any = null

    // Per-room processing lock + mention queue
    private _processingRooms = new Set<string>()
    private _mentionQueue = new Map<string, Array<{ agent: AgentClient; msg: MentionMessage; sessionSeed: string }>>()

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient(config, handlers)
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._contextEngine) client.setContextEngine(this._contextEngine)
        if (this._storage) client.setStorage(this._storage)

        logger.info(`[AgentClients] Connected: ${client.name} (${client.agentId})`)
        return client
    }

    /**
     * Connect an agent to a room.
     */
    async addAgentToRoom(roomId: string, client: AgentClient): Promise<JoinResult> {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }

        room.set(client.agentId, client)
        try {
            const result = await client.joinRoom(roomId)
            logger.info(`[AgentClients] ${client.name} joined room: ${roomId}`)
            return result
        } catch (err) {
            room.delete(client.agentId)
            if (room.size === 0) this.rooms.delete(roomId)
            client.disconnect()
            throw err
        }
    }

    /**
     * Remove an agent from a room and disconnect it.
     */
    removeAgentFromRoom(roomId: string, agentId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        const client = room.get(agentId)
        if (client) {
            client.disconnect()
            room.delete(agentId)
            logger.info(`[AgentClients] ${client.name} left room: ${roomId}`)

            // Invalidate context engine cache for this agent
            if (this._contextEngine) {
                try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
            }
        }

        if (room.size === 0) {
            this.rooms.delete(roomId)
        }
    }

    /**
     * Get all agents in a room.
     */
    getAgents(roomId: string): AgentClient[] {
        const room = this.rooms.get(roomId)
        return room ? Array.from(room.values()) : []
    }

    /**
     * Get a specific agent in a room.
     */
    getAgent(roomId: string, agentId: string): AgentClient | undefined {
        return this.rooms.get(roomId)?.get(agentId)
    }

    /**
     * Get all room IDs that have agents.
     */
    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    /**
     * Send a message from a specific agent in a room.
     */
    async sendMessage(roomId: string, agentId: string, content: string): Promise<string> {
        const client = this.getAgent(roomId, agentId)
        if (!client) {
            throw new Error(`Agent "${agentId}" not found in room "${roomId}"`)
        }
        return client.sendMessage(roomId, content)
    }

    /**
     * Broadcast a message from all agents in a room.
     */
    async broadcastFromRoom(roomId: string, content: string): Promise<string[]> {
        const agents = this.getAgents(roomId)
        return Promise.all(agents.map((agent) => agent.sendMessage(roomId, content)))
    }

    async interruptAgent(roomId: string, agentName: string): Promise<void> {
        const agent = this.getAgents(roomId).find(a => a.name === agentName)
        if (!agent) throw new Error(`Agent "${agentName}" not found in room "${roomId}"`)
        this.clearQueuedMentionsForAgent(roomId, agent.name, 'interrupt')
        await agent.interrupt(roomId)
    }

    /**
     * Disconnect all agents in a room.
     */
    disconnectRoom(roomId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        room.forEach((client) => client.disconnect())
        this.rooms.delete(roomId)
        logger.info(`[AgentClients] All agents disconnected from room: ${roomId}`)

        // Invalidate context engine cache for this room
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
    }

    resetRoomContext(roomId: string): void {
        this.clearQueuedMentionsForRoom(roomId, 'room_reset')
        for (const agent of this.getAgents(roomId)) {
            void agent.cancelActiveRun(roomId).catch((err: any) => {
                logger.debug(`[AgentClients] failed to cancel active run for ${agent.name} in ${roomId}: ${err.message}`)
            })
        }
        for (const key of Array.from(this._processingRooms)) {
            if (key.startsWith(`${roomId}:`)) this._processingRooms.delete(key)
        }
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
    }

    /**
     * Disconnect all agents in all rooms.
     */
    disconnectAll(): void {
        this.rooms.forEach((room) => {
            room.forEach((client) => client.disconnect())
        })
        this.rooms.clear()
        logger.info('[AgentClients] All agents disconnected')
    }

    /**
     * Set context engine for all existing and future agents.
     */
    setContextEngine(engine: any): void {
        this._contextEngine = engine
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setContextEngine(engine))
        })
    }

    /**
     * Set message storage for all existing and future agents.
     */
    setStorage(storage: any): void {
        this._storage = storage
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setStorage(storage))
        })
    }

    private clearQueuedMentionsForAgent(roomId: string, agentName: string, reason: string): number {
        const agentKey = `${roomId}:${agentName}`
        const queue = this._mentionQueue.get(agentKey)
        if (!queue?.length) {
            this._mentionQueue.delete(agentKey)
            return 0
        }
        this._mentionQueue.delete(agentKey)
        logMentionQueueDrop({
            roomId,
            agentName,
            reason,
            droppedCount: queue.length,
            messageId: queue[queue.length - 1]?.msg.messageId,
        })
        return queue.length
    }

    private clearQueuedMentionsForRoom(roomId: string, reason: string): number {
        let droppedCount = 0
        for (const [agentKey, queue] of Array.from(this._mentionQueue.entries())) {
            if (!agentKey.startsWith(`${roomId}:`)) continue
            this._mentionQueue.delete(agentKey)
            if (!queue.length) continue
            const agentName = agentKey.slice(roomId.length + 1)
            droppedCount += queue.length
            logMentionQueueDrop({
                roomId,
                agentName,
                reason,
                droppedCount: queue.length,
                messageId: queue[queue.length - 1]?.msg.messageId,
            })
        }
        return droppedCount
    }

    private currentRoomGeneration(roomId: string): string {
        return getRoomGeneration(this._storage, roomId)
    }

    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: MentionMessage): Promise<void> {
        const agents = this.getAgents(roomId)
        const mentionScope = defaultMentionRoutingScope({ senderKind: msg.senderKind })
        const routing = resolveMentionRouting(agents, msg.input ?? msg.content, msg.senderId, {
            senderKind: msg.senderKind,
            scope: mentionScope,
        })
        const mentioned = routing.targets

        msg.mentionRouting = {
            targetNames: routing.targetNames,
            scope: routing.scope,
            addressBlock: routing.addressBlock
                ? { range: routing.addressBlock.range, textBlockIndex: routing.addressBlock.textBlockIndex }
                : null,
        }

        logger.info({
            roomId,
            senderKind: msg.senderKind,
            routingMode: mentionScope,
            scope: routing.scope,
            senderName: msg.senderName,
            targetNames: routing.targetNames,
            mentionDepth: Math.max(0, msg.mentionDepth || 0),
            messageId: msg.messageId,
        }, '[GroupChat] mention routing decision')

        if (mentioned.length === 0) return

        const sessionSeed = this.currentRoomGeneration(roomId)
        for (const agent of mentioned) {
            this._processAgentMention(roomId, agent, msg, sessionSeed).catch((err) => {
                logger.error(`[AgentClients] error processing mention for ${agent.name}: ${err.message}`)
            })
        }
    }

    /**
     * Process a single agent mention with status reporting and queue drain.
     */
    private async _processAgentMention(
        roomId: string,
        agent: AgentClient,
        msg: MentionMessage,
        sessionSeed: string,
    ): Promise<void> {
        const agentKey = `${roomId}:${agent.name}`
        if (this._processingRooms.has(agentKey)) {
            let queue = this._mentionQueue.get(agentKey)
            if (!queue) {
                queue = [] as Array<{ agent: AgentClient; msg: MentionMessage; sessionSeed: string }>
                this._mentionQueue.set(agentKey, queue)
            }
            queue.push({ agent, msg, sessionSeed })
            logger.debug({
                roomId,
                agentName: agent.name,
                messageId: msg.messageId,
                queuedCount: queue.length,
                reason: 'agent_busy',
            }, '[GroupChat] mention queued')
            return
        }

        const currentGeneration = this.currentRoomGeneration(roomId)
        if (sessionSeed !== currentGeneration) {
            logMentionQueueDrop({
                roomId,
                agentName: agent.name,
                reason: 'stale_generation_before_start',
                droppedCount: 1,
                messageId: msg.messageId,
                queuedGeneration: sessionSeed,
                currentGeneration,
            })
            return
        }

        this._processingRooms.add(agentKey)
        const onStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
            agent.emitContextStatus(roomId, status, extra, sessionSeed)
            logger.debug({ roomId, agentName: agent.name, status, ...(extra || {}) }, '[GroupChat] agent status')
        }

        try {
            await agent.replyToMention(roomId, msg, onStatus)
        } finally {
            this._processingRooms.delete(agentKey)
            await this._drainQueue(agentKey, roomId)
        }
    }

    /**
     * Drain queued mentions for a room after processing completes.
     */
    private async _drainQueue(agentKey: string, roomId: string): Promise<void> {
        const queue = this._mentionQueue.get(agentKey)
        if (!queue || queue.length === 0) return

        this._mentionQueue.delete(agentKey)
        const last = queue[queue.length - 1]
        const agentName = last?.agent.name || agentKey.slice(roomId.length + 1)
        const droppedCount = Math.max(0, queue.length - 1)
        if (droppedCount > 0) {
            logMentionQueueDrop({
                roomId,
                agentName,
                reason: 'superseded_by_latest',
                droppedCount,
                messageId: last?.msg.messageId,
            })
        }

        const currentGeneration = this.currentRoomGeneration(roomId)
        if (!last || last.sessionSeed !== currentGeneration) {
            logMentionQueueDrop({
                roomId,
                agentName,
                reason: 'stale_generation_after_queue',
                droppedCount: last ? 1 : 0,
                messageId: last?.msg.messageId,
                queuedGeneration: last?.sessionSeed,
                currentGeneration,
            })
            return
        }
        await this._processAgentMention(roomId, last.agent, last.msg, last.sessionSeed)
    }
}

function nextMentionDepth(msg: MentionMessage): number {
    return Math.max(0, msg.mentionDepth || 0) + 1
}
