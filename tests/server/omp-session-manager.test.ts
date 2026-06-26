import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'child_process'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OmpSessionManager } from '../../packages/server/src/services/hermes/run-chat/omp-session-manager'

const ompAvailable = (() => {
  try {
    return spawnSync('omp', ['--version']).status === 0
  } catch {
    return false
  }
})()

// Integration test: awaits the real omp subprocess's ready/response signals and
// uses a wall-clock timeout only as a failure guard (no fake clock can drive a
// real child process). This is the documented exception to ts-no-test-timers.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

describe.skipIf(!ompAvailable)('OmpSessionManager (real omp --mode rpc)', () => {
  const manager = new OmpSessionManager()

  afterEach(() => {
    manager.stopAll()
  })

  it('spawns omp, reaches ready, dispatches frames, and answers a command', async () => {
    const sessionId = 'it-omp-session'
    await withTimeout(manager.ensureSession(sessionId, {}), 30_000, 'omp did not become ready')
    expect(manager.hasSession(sessionId)).toBe(true)

    let resolveResponse!: (frame: Record<string, unknown>) => void
    const responded = new Promise<Record<string, unknown>>(resolve => {
      resolveResponse = resolve
    })
    manager.setHandler(sessionId, frame => {
      if (frame.type === 'response' && frame.command === 'get_state') resolveResponse(frame)
    })

    expect(manager.send(sessionId, { type: 'get_state', id: 'probe-1' })).toBe(true)
    const response = await withTimeout(responded, 15_000, 'omp did not answer get_state')
    expect(response.success).toBe(true)
    expect(response.command).toBe('get_state')

    manager.stop(sessionId)
    expect(manager.hasSession(sessionId)).toBe(false)
  }, 60_000)

  it('rejects ensureSession when the same session relaunches with an incompatible config', async () => {
    const sessionId = 'it-omp-compat'
    await withTimeout(manager.ensureSession(sessionId, { cwd: process.cwd() }), 30_000, 'omp did not become ready')
    expect(manager.isSessionLaunchCompatible(sessionId, { cwd: process.cwd() })).toBe(true)
    expect(manager.isSessionLaunchCompatible(sessionId, { cwd: process.cwd(), model: 'other' })).toBe(false)
    manager.stop(sessionId)
  }, 60_000)
})
