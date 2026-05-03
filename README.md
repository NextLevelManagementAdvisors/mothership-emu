# mothership-emu

Self-hosted replacement for sim.ai's hosted Mothership/Copilot service. Drops in as `SIM_AGENT_API_URL` so [simstudioai/sim](https://github.com/simstudioai/sim) self-hosters can use the in-app Copilot panel without a sim.ai dependency.

**Status: skeleton.** Routes are stubbed. Real chat orchestration via [`@anthropic-ai/claude-agent-sdk`](https://platform.claude.com/docs/en/agent-sdk/typescript) is the next milestone. Patches very welcome.

## Why

Sim's in-app Copilot panel calls `${SIM_AGENT_API_URL}/api/copilot/...` on every message. Stock sim points that at `https://copilot.sim.ai` (Mothership), which validates against sim.ai's hosted infra and meters every call against your sim.ai plan. Self-hosters either pay sim.ai or the panel breaks (see [sim issue #1324](https://github.com/simstudioai/sim/issues/1324)).

Mothership-emu is a tiny Bun HTTP server that speaks the same wire protocol but runs the agent loop locally using the Anthropic Claude Agent SDK + your own API key. Sim's source needs no patches beyond setting one env var.

## Quick start (when implemented)

```bash
bun install
ANTHROPIC_API_KEY=sk-ant-... bun start
```

In your sim self-hosted `.env`:
```
SIM_AGENT_API_URL=http://127.0.0.1:3040
```

Restart sim. The in-app Copilot panel now talks to mothership-emu.

## What's implemented (v0.0.1 skeleton)

| Endpoint | Status | Notes |
|---|---|---|
| `POST /api/copilot` | stub: returns "not implemented" SSE | Main chat brain — biggest piece |
| `POST /api/mothership` | stub | Workspace-scoped chat variant |
| `POST /api/mothership/execute` | 501 | Non-streaming Mothership block exec |
| `POST /api/subagent/<id>` | error event | Subagent recursion; drop in v0.1 |
| `POST /api/tools/resume` | stub | Resume after paused tool exec |
| `POST /api/validate-key/*` | 401/410 | Sim's local-Copilot-Keys patch handles these now |
| `POST /api/generate-chat-title` | echoes message prefix | Stub; can call Claude later |
| `POST /api/get-available-models` | claude lineup | Static list |
| `POST /api/chats/fork` | no-op success | Sim handles fork in DB |
| `POST /api/streams/explicit-abort` | ack | Aborts handled by sim's runtime |
| `POST /api/stats` `/tasks/cleanup` `/tool-preferences/auto-allowed` `/traces` | empty success | Telemetry sinks |

## Roadmap

- **v0.1 — basic chat (1-2 days)**: parse Mothership payload, run `query()` from claude-agent-sdk, translate stream events to MothershipStreamV1 format, stream over SSE. Drops subagent tools (`sim_workflow`, `sim_research`, etc.) — those are nested-agent loops that need bespoke implementation.
- **v0.2 — tool dispatch**: wire sim's 43 direct tools as `tool()` defs in the SDK; tool handlers HTTP-callback to sim's `/api/copilot/tool/execute` endpoint to reuse sim's existing executeTool registry.
- **v0.3 — checkpoint/resume**: handle `/api/tools/resume` for human-in-the-loop pauses.
- **v0.4 — chat title gen**: real Claude call instead of echo.
- **v1.0 — subagent emulation**: implement `sim_workflow`, `sim_research`, `sim_superagent` etc. as nested agent loops with their own system prompts. Optional — claude can compose direct tools to achieve most of what subagents do.

## Wire protocol reference

Reverse-engineered from `apps/sim/lib/copilot/request/` in [simstudioai/sim](https://github.com/simstudioai/sim).

### Incoming payload (POST `/api/copilot` or `/api/mothership`)

```jsonc
{
  "conversation": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "...", "toolCalls": [...]},
    {"role": "tool", "toolCallId": "...", "result": {...}}
  ],
  "contexts": [
    {"type": "workflow", "id": "..."},
    {"type": "file", "id": "..."},
    {"type": "knowledge_base", "id": "..."}
  ],
  "fileAttachments": [...],
  "userPermission": "read|write|admin",
  "userTimezone": "America/New_York",
  "workspaceContext": {"id": "...", "name": "..."},
  "messageId": "...",
  "chatId": "...",
  "executionId": "...",
  "runId": "...",
  "model": "claude-sonnet-4-6"  // optional override
}
```

### Outgoing SSE event types (MothershipStreamV1)

From `apps/sim/lib/copilot/generated/mothership-stream-v1.ts`:

```ts
type MothershipStreamV1EventType = 'session' | 'text' | 'tool' | 'span' | 'resource' | 'run' | 'error' | 'complete'
type MothershipStreamV1TextChannel = 'assistant' | 'thinking'
type MothershipStreamV1ToolExecutor = 'sim' | 'go' | 'client'
type MothershipStreamV1ToolMode = 'sync' | 'async'
type MothershipStreamV1ToolOutcome = 'success' | 'error' | 'cancelled' | 'skipped' | 'rejected'
type MothershipStreamV1SpanPayloadKind = 'subagent' | 'structured_result' | 'subagent_result'
type MothershipStreamV1RunKind = 'checkpoint_pause' | 'resumed' | 'compaction_start' | 'compaction_done'
type MothershipStreamV1ResourceOp = 'upsert' | 'remove'
```

Each SSE event is `data: ${JSON.stringify({type, payload})}\n\n`.

### Tool dispatch flow

1. mothership-emu receives chat request from sim
2. Calls `query()` with sim's tool defs as Anthropic tool defs
3. Claude returns `tool_use` event
4. Emit `{type: 'tool', payload: {executor: 'sim', mode: 'sync', name, args}}` to sim
5. Sim's frontend dispatches the tool via `/api/copilot/tool/execute` which runs `executeTool(toolId, args, ctx)` against the local handler registry
6. Sim sends the result back via the SSE return channel (or via callback — TBD which the protocol uses)
7. Feed result back into `query()` via the SDK's tool result mechanism
8. Loop until Claude emits `end_turn`
9. Emit `{type: 'complete', payload: {usage, cost}}`

Last step is what makes "use the SDK" attractive — the loop coordination is the SDK's job, not ours.

## Companion patches in sim

This project pairs with NLMA's sim fork at [NextLevelManagementAdvisors/sim](https://github.com/NextLevelManagementAdvisors/sim) which adds:
- BYOK keys actually work on self-hosted (`apps/sim/lib/api-key/byok.ts`)
- 33 additional MCP tool exposures (`apps/sim/lib/copilot/tools/mcp/definitions.ts`)
- Workspace API key auth on `/api/mcp/copilot` (`apps/sim/app/api/mcp/copilot/route.ts`)
- Local Copilot Keys page (`apps/sim/app/api/copilot/api-keys/...`)
- BYOK + Copilot Keys nav items visible on self-hosted

The sim fork makes self-hosting viable. Mothership-emu makes the in-app Copilot panel viable on self-hosted. Together = full sovereignty.

## License

Apache 2.0.
