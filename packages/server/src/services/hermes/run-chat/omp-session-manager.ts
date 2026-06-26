/**
 * OmpSessionManager — manages per-session `omp --mode rpc` child processes.
 *
 * One omp process per chat session, lazily spawned and reused across runs so
 * omp keeps its in-process conversation context. omp speaks newline-delimited
 * JSON: it emits `{"type":"ready"}` on startup, then streams AgentSessionEvent
 * frames and command responses on stdout; commands are written to stdin as JSON
 * lines. Frames are dispatched to the active run's handler. Processes are killed
 * on idle, shutdown, or incompatible relaunch (different model/provider/cwd).
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { logger } from '../../logger'
import {
  normalizeWindowsCommandPath,
  windowsCmdShimExecution,
  windowsCommandNeedsShell,
} from '../../windows-command'

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const DEFAULT_OMP_COMMAND = process.env.HERMES_OMP_COMMAND || 'omp'
const READY_TIMEOUT_MS = envPositiveInt('HERMES_OMP_READY_TIMEOUT_MS') ?? 30_000
const DEFAULT_IDLE_MS = envPositiveInt('HERMES_OMP_IDLE_MS') ?? 30 * 60 * 1000
const STDERR_TAIL_CHARS = 8 * 1024

/** Synthetic frame the manager injects when an omp process dies unexpectedly. */
export const OMP_EXIT_FRAME_TYPE = '__omp_exit'

/**
 * extension_ui_request methods that block omp until the host replies. We run
 * headless, so the manager auto-cancels them to keep the agent from stalling on
 * a UI prompt no one can answer (matches the omp-desktop host behavior).
 */
const RESPONSE_REQUIRING_UI_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
}

export interface OmpLaunchOptions {
  cwd?: string
  model?: string
  provider?: string
  sessionDir?: string
  env?: Record<string, string>
}

export type OmpFrame = Record<string, unknown>
export type OmpFrameHandler = (frame: OmpFrame) => void

function launchKeyOf(launch: OmpLaunchOptions): string {
  return [launch.cwd || '', launch.model || '', launch.provider || '', launch.sessionDir || ''].join('\u0000')
}

interface ManagedOmpSession {
  sessionId: string
  child: ChildProcess
  stdin: NodeJS.WritableStream
  rl: Interface
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (err: Error) => void
  readySettled: boolean
  handler?: OmpFrameHandler
  launchKey: string
  lastActivity: number
  idleTimer?: NodeJS.Timeout
  stderrTail: string
  exited: boolean
  exitReason?: string
}

export class OmpSessionManager {
  #sessions = new Map<string, ManagedOmpSession>()

  hasSession(sessionId: string): boolean {
    const s = this.#sessions.get(sessionId)
    return Boolean(s && !s.exited)
  }

  isSessionLaunchCompatible(sessionId: string, launch: OmpLaunchOptions): boolean {
    const s = this.#sessions.get(sessionId)
    return Boolean(s && !s.exited && s.launchKey === launchKeyOf(launch))
  }

  /** Spawn (or reuse) the omp process for a session and resolve once it is ready. */
  async ensureSession(sessionId: string, launch: OmpLaunchOptions = {}): Promise<void> {
    const existing = this.#sessions.get(sessionId)
    if (existing && !existing.exited) {
      if (existing.launchKey === launchKeyOf(launch)) {
        this.#touch(existing)
        await existing.ready
        return
      }
      // Different launch config (model/provider/cwd) — restart the process.
      this.stop(sessionId)
    }
    const session = this.#spawn(sessionId, launch)
    this.#sessions.set(sessionId, session)
    try {
      await session.ready
    } catch (err) {
      this.#sessions.delete(sessionId)
      throw err
    }
  }

  setHandler(sessionId: string, handler: OmpFrameHandler): void {
    const s = this.#sessions.get(sessionId)
    if (s) s.handler = handler
  }

  clearHandler(sessionId: string): void {
    const s = this.#sessions.get(sessionId)
    if (s) s.handler = undefined
  }

  send(sessionId: string, command: Record<string, unknown>): boolean {
    const s = this.#sessions.get(sessionId)
    if (!s || s.exited) return false
    try {
      s.stdin.write(JSON.stringify(command) + '\n')
      this.#touch(s)
      return true
    } catch (err) {
      logger.warn(err, '[omp-session] failed to write command for session %s', sessionId)
      return false
    }
  }

  prompt(sessionId: string, message: string, runId: string): boolean {
    return this.send(sessionId, { type: 'prompt', id: runId, message })
  }

  abort(sessionId: string): boolean {
    return this.send(sessionId, { type: 'abort' })
  }

  lastError(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.exitReason
  }

  stop(sessionId: string): void {
    const s = this.#sessions.get(sessionId)
    if (!s) return
    this.#sessions.delete(sessionId)
    clearTimeout(s.idleTimer)
    s.handler = undefined
    s.exited = true
    try {
      s.rl.close()
    } catch {
      // ignore
    }
    try {
      s.child.kill('SIGTERM')
    } catch (err) {
      logger.debug(err, '[omp-session] kill failed for session %s', sessionId)
    }
  }

  stopAll(): void {
    for (const id of [...this.#sessions.keys()]) this.stop(id)
  }

  #spawn(sessionId: string, launch: OmpLaunchOptions): ManagedOmpSession {
    const args = ['--mode', 'rpc']
    if (launch.provider) args.push('--provider', launch.provider)
    if (launch.model) args.push('--model', launch.model)
    if (launch.sessionDir) args.push('--session-dir', launch.sessionDir)

    let command = DEFAULT_OMP_COMMAND
    let spawnArgs = args
    let windowsVerbatimArguments = false
    if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
      const exec = windowsCmdShimExecution(normalizeWindowsCommandPath(command), args)
      command = exec.command
      spawnArgs = exec.args
      windowsVerbatimArguments = true
    }

    const child = spawn(command, spawnArgs, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments,
    })

    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    const session: ManagedOmpSession = {
      sessionId,
      child,
      stdin: child.stdin as NodeJS.WritableStream,
      rl,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      launchKey: launchKeyOf(launch),
      lastActivity: Date.now(),
      stderrTail: '',
      exited: false,
    }

    const readyTimer = setTimeout(() => {
      if (session.readySettled) return
      session.readySettled = true
      const tail = session.stderrTail.trim()
      session.rejectReady(new Error(`omp did not become ready within ${READY_TIMEOUT_MS}ms${tail ? `: ${tail}` : ''}`))
      this.stop(sessionId)
    }, READY_TIMEOUT_MS)
    readyTimer.unref?.()
    void ready.then(() => clearTimeout(readyTimer)).catch(() => clearTimeout(readyTimer))

    rl.on('line', raw => this.#onLine(session, raw))
    child.stderr?.on('data', (chunk: Buffer) => {
      session.stderrTail = (session.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', err => {
      this.#onExit(session, err instanceof Error ? err.message : String(err))
    })
    child.on('exit', (code, signal) => {
      const reason = code != null ? `omp exited with code ${code}` : `omp terminated by signal ${signal}`
      this.#onExit(session, reason)
    })

    this.#scheduleIdle(session)
    return session
  }

  #onLine(session: ManagedOmpSession, raw: string): void {
    const line = raw.trim()
    if (!line) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      logger.debug('[omp-session] non-JSON line from session %s: %s', session.sessionId, line.slice(0, 200))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const frame = parsed as OmpFrame
    this.#touch(session)
    if (!session.readySettled && frame.type === 'ready') {
      session.readySettled = true
      session.resolveReady()
      return
    }
    if (frame.type === 'extension_ui_request') this.#autoCancelUiRequest(session, frame)
    session.handler?.(frame)
  }

  #autoCancelUiRequest(session: ManagedOmpSession, frame: OmpFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const method = typeof frame.method === 'string' ? frame.method : ''
    if (!id || !RESPONSE_REQUIRING_UI_METHODS[method]) return
    try {
      session.stdin.write(JSON.stringify({ type: 'extension_ui_response', id, cancelled: true }) + '\n')
    } catch (err) {
      logger.debug(err, '[omp-session] failed to auto-cancel UI request for session %s', session.sessionId)
    }
  }

  #onExit(session: ManagedOmpSession, reason: string): void {
    if (session.exited) return
    session.exited = true
    session.exitReason = reason
    clearTimeout(session.idleTimer)
    this.#sessions.delete(session.sessionId)
    if (!session.readySettled) {
      session.readySettled = true
      const tail = session.stderrTail.trim()
      session.rejectReady(new Error(`${reason}${tail ? `: ${tail}` : ''}`))
    }
    const handler = session.handler
    session.handler = undefined
    handler?.({ type: OMP_EXIT_FRAME_TYPE, reason })
    logger.info('[omp-session] session %s ended: %s', session.sessionId, reason)
  }

  #touch(session: ManagedOmpSession): void {
    session.lastActivity = Date.now()
    this.#scheduleIdle(session)
  }

  #scheduleIdle(session: ManagedOmpSession): void {
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      logger.info('[omp-session] recycling idle session %s', session.sessionId)
      this.stop(session.sessionId)
    }, DEFAULT_IDLE_MS)
    session.idleTimer.unref?.()
  }
}

export const ompSessionManager = new OmpSessionManager()
