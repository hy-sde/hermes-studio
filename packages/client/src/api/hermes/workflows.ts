import { request } from '../client'

export interface WorkflowViewport {
  x: number
  y: number
  zoom: number
}

export interface WorkflowRecord {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes: unknown[]
  edges: unknown[]
  viewport: WorkflowViewport | Record<string, unknown> | null
  created_at: number
  updated_at: number
}

export interface WorkflowCreateRequest {
  name: string
  profile?: string | null
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowUpdateRequest {
  name?: string
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowBatchDeleteResult {
  deleted: number
  failed: number
  errors: Array<{ id: string; error: string }>
}

function appendProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const params = new URLSearchParams()
  params.set('profile', profile)
  return `${path}?${params}`
}

export async function listWorkflows(profile?: string | null): Promise<WorkflowRecord[]> {
  const path = appendProfile('/api/hermes/workflows', profile)
  const res = await request<{ workflows: WorkflowRecord[] }>(path)
  return res.workflows
}

export async function fetchWorkflow(id: string): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/hermes/workflows/${encodeURIComponent(id)}`)
  return res.workflow
}

export async function createWorkflow(input: WorkflowCreateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>('/api/hermes/workflows', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.workflow
}

export async function updateWorkflow(id: string, patch: WorkflowUpdateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/hermes/workflows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return res.workflow
}

export async function deleteWorkflow(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/hermes/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function batchDeleteWorkflows(ids: string[]): Promise<WorkflowBatchDeleteResult> {
  return request<WorkflowBatchDeleteResult>('/api/hermes/workflows/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}
