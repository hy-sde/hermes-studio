# Workflow Page

This document records the current Workflow page implementation in Hermes Web UI.
The page is still a front-end workflow builder plus persistence layer. Workflow
execution is intentionally not wired yet.

## Entry Points

- Client route: `/hermes/workflow`
- Client view: `packages/client/src/views/hermes/WorkflowView.vue`
- Agent node component:
  `packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue`
- Client API helper: `packages/client/src/api/hermes/workflows.ts`
- Server routes: `packages/server/src/routes/hermes/workflows.ts`
- Server controller: `packages/server/src/controllers/hermes/workflows.ts`
- Server service singleton: `packages/server/src/services/workflow-manager.ts`
- Server socket: `packages/server/src/services/workflow-socket.ts`
- Store: `packages/server/src/db/hermes/workflow-store.ts`
- Schema: `packages/server/src/db/hermes/schemas.ts`

The Workflow page is opened from the same left page sidebar used by chat,
history, and group chat. The workflow list also lives in the left sidebar.

## Implemented UI

- Vue Flow is used for the canvas.
- Users can create, edit, save, delete, and batch delete workflows.
- The create workflow drawer collects:
  - workflow name
  - profile
  - optional workspace directory
- If no workspace is selected, the server creates a default workspace:
  `~/.hermes-web-ui/workflow/<profile>/<workflowId>`.
- The workflow sidebar supports:
  - profile filter
  - batch mode
  - select all
  - batch delete
  - per-row delete
  - empty/loading states
- Workflow rows show name, profile, node count, and edge count.
- The canvas toolbar includes:
  - add node
  - save
  - start execution placeholder
- The start execution button currently only shows a "not connected yet" message.

## Node Behavior

Workflow nodes are custom agent nodes. Each node has:

- title
- agent selector: `hermes`, `claude-code`, `codex`
- provider/model selector
- API mode selector for coding agents
- skills tag input
- main input textarea
- file/image attachments
- one left input handle
- one right output handle

The node frame is resizable. The textarea grows with the node height instead of
being independently resized.

Attachments use the shared upload endpoint through `uploadRuntimeFiles`. Images
render as thumbnails and open in a full-screen preview overlay. Non-image files
render as file chips. The upload button remains last in the attachment flow.

## Edge Behavior

Edges are Vue Flow `smoothstep` edges with dashed styling and arrow markers.

Connections are constrained in two places:

- During dragging, `isValidWorkflowConnection` only allows right output to left
  input.
- During save, existing edges are validated again so bad loaded data cannot be
  saved silently.

Valid edge shape:

```json
{
  "id": "agent-1-agent-2",
  "source": "agent-1",
  "target": "agent-2",
  "sourceHandle": "output",
  "targetHandle": "input",
  "type": "smoothstep",
  "animated": true
}
```

Invalid examples:

- input to input
- output to output
- left input to right output
- self connection
- connection to a missing node

## Save Validation

Saving a workflow is blocked on the client when any of these checks fail:

- at least one node is required
- every node needs a title
- every node needs a provider
- every node needs a model
- coding-agent nodes need an API mode
- every node needs input text
- every edge must reference existing nodes
- every edge must go from `output` to `input`
- with more than one node, no node can be completely disconnected
- the graph must be one connected workflow, not multiple independent flows
- the directed graph must not contain a cycle

The graph allows:

- multiple start nodes
- multiple terminal nodes
- branching
- merging

The graph does not allow parallel disconnected flows. For example,
`A -> B` and `C -> D` in the same workflow is invalid until the two groups are
connected into one workflow graph.

Cycle detection is directed. Connectivity detection is undirected, because it is
only used to catch disconnected groups.

## Persistence

Workflow definitions are persisted in the `workflows` table.

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'default',
  workspace TEXT,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  viewport_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

The schema sync code adds new workflow columns safely on startup. Existing
databases do not need a manual migration for `viewport_json`.

`nodes_json` stores the serialized Vue Flow nodes with runtime callbacks removed.
`edges_json` stores Vue Flow edge definitions. `viewport_json` stores the current
canvas viewport:

```json
{
  "x": 80,
  "y": 80,
  "zoom": 0.75
}
```

The page restores the saved viewport when switching to a workflow or reloading
the workflow list. Save sends the current `x`, `y`, and `zoom` together with
nodes and edges.

## API

Routes:

- `GET /api/hermes/workflows`
- `GET /api/hermes/workflows?profile=<profile>`
- `POST /api/hermes/workflows`
- `GET /api/hermes/workflows/:id`
- `PATCH /api/hermes/workflows/:id`
- `DELETE /api/hermes/workflows/:id`
- `POST /api/hermes/workflows/batch-delete`

Socket namespace:

- `/workflow`
- `workflows.list` returns the same workflow list shape as the HTTP list API.
- `workflow.status.subscribe` subscribes to accessible workflow status rooms, or
  to a single workflow by `workflowId`.
- `workflow.status.unsubscribe` leaves the matching status room.
- `workflow.status.updated` is emitted when the server-side workflow manager
  publishes a runtime status change.

Create body:

```json
{
  "name": "Research Flow",
  "profile": "default",
  "workspace": null,
  "nodes": [],
  "edges": [],
  "viewport": { "x": 80, "y": 80, "zoom": 0.75 }
}
```

Patch body supports partial updates:

```json
{
  "name": "Updated Flow",
  "workspace": "/path/to/workspace",
  "nodes": [],
  "edges": [],
  "viewport": { "x": -200, "y": 120, "zoom": 0.9 }
}
```

Batch delete body:

```json
{
  "ids": ["workflow-id-1", "workflow-id-2"]
}
```

The controller enforces profile access for non-super-admin users. The store
persists data in SQLite when available and falls back to the JSON store helpers
when no SQLite database is active.

## Execution Tables

The schema already includes run-oriented tables for future execution work:

- `workflow_runs`
- `workflow_run_messages`

These tables are not wired to the UI execution button yet. They exist so the
next implementation step can snapshot the workflow definition at run start and
store per-node run messages.

## Current Limitations

- Workflow execution is not implemented.
- Server-side save validation currently validates request shapes and profile
  access. Graph semantic validation is implemented in the client save path.
- Attachments are stored as uploaded file paths on node data. There is no
  separate workflow attachment table.
- Skills are currently stored as names on the node and are not resolved until
  future execution work.

## Validation

Relevant checks used while building this feature:

```bash
npm run test -- tests/server/workflow-store.test.ts tests/server/schema-sync.test.ts
npm run build
git diff --check
```
