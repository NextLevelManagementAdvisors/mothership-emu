# mothership-emu

Self-hosted replacement for sim.ai's hosted Mothership/Copilot service. Drops in as `SIM_AGENT_API_URL` so [simstudioai/sim](https://github.com/simstudioai/sim) self-hosters can use the in-app Copilot panel without a sim.ai dependency.

**Status: v0.1 — basic chat working end-to-end.** Real chat orchestration via [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript) is wired up; sim's MCP tool catalog is dynamically registered as the tool surface; SDK message stream is translated into MothershipStreamV1 SSE. Subagents and checkpoint/resume are still stubbed (see roadmap). Patches very welcome.

## Why

Sim's in-app Copilot panel calls `${SIM_AGENT_API_URL}/api/copilot/...` on every message. Stock sim points that at `https://copilot.sim.ai` (Mothership), which validates against sim.ai's hosted infra and meters every call against your sim.ai plan. Self-hosters either pay sim.ai or the panel breaks (see [sim issue #1324](https://github.com/simstudioai/sim/issues/1324)).

Mothership-emu is a tiny Bun HTTP server that speaks the same wire protocol but runs the agent loop locally using the Anthropic Claude Agent SDK + your own API key. Sim's source needs no patches beyond setting one env var.

## Quick start

```bash
bun install
# Required: Anthropic API key (claude-agent-sdk uses this for the brain)
export ANTHROPIC_API_KEY=sk-ant-...
# Required: where sim is reachable (use the docker network name when sidecar-deployed)
export SIM_BASE_URL=http://simstudio:3000
# Required: a sim workspace API key with broad access; mothership-emu uses it to call
# sim's /api/mcp/copilot endpoint (JSON-RPC tools/list + tools/call) to dispatch tools.
export SIM_INTERNAL_API_KEY=sk-sim-...
# Optional
export MOTHERSHIP_DEFAULT_MODEL=claude-sonnet-4-6   # fallback when sim doesn't pick one
export MOTHERSHIP_SYSTEM_PROMPT='...'               # override the default Sim Copilot prompt
bun start
```

In your sim self-hosted `.env`:
```
SIM_AGENT_API_URL=http://mothership-emu:3040
```

Restart sim. The in-app Copilot panel now talks to mothership-emu.

### Docker sidecar deployment (recommended)

Mothership-emu is built to run as a sidecar in sim's compose stack. Add to `/opt/sim/docker-compose.yml`:

```yaml
  mothership-emu:
    image: mothership-emu:latest    # or build from this repo
    restart: unless-stopped
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SIM_BASE_URL: http://simstudio:3000
      SIM_INTERNAL_API_KEY: ${SIM_INTERNAL_API_KEY}
    networks:
      - sim-network
```

The Dockerfile installs Node and `@anthropic-ai/claude-code` globally because claude-agent-sdk spawns the `claude` CLI as a subprocess for the actual agent loop.

## What's implemented (v0.1)

| Endpoint | Status | Notes |
|---|---|---|
| `POST /api/copilot` | **working** — claude-agent-sdk + sim MCP tools | Main chat brain |
| `POST /api/mothership` | **working** — same handler as `/api/copilot` | Workspace-scoped chat variant |
| `POST /api/mothership/execute` | 501 | Non-streaming Mothership block exec — niche |
| `POST /api/subagent/<id>` | error event | Subagent recursion; v1.0 |
| `POST /api/tools/resume` | error event | Checkpoint/resume; v0.3 |
| `POST /api/validate-key/*` | 401/410 | Sim's local-Copilot-Keys patch handles these now |
| `POST /api/generate-chat-title` | echoes message prefix | Stub; v0.4 will call Claude |
| `POST /api/get-available-models` | claude lineup | Static list |
| `POST /api/chats/fork` | no-op success | Sim handles fork in DB |
| `POST /api/streams/explicit-abort` | ack | Aborts handled by sim's runtime |
| `POST /api/stats` `/tasks/cleanup` `/tool-preferences/auto-allowed` `/traces` | empty success | Telemetry sinks |

### How v0.1 works

1. Sim sends a Mothership-format chat request (conversation history, contexts, model hint).
2. mothership-emu calls sim's `/api/mcp/copilot` (JSON-RPC `tools/list`) once at startup to learn the available tool surface, then registers each tool as a proxy in an SDK MCP server.
3. The conversation is flattened into a single transcript prompt (v0.1 trade-off — we replay history every turn instead of using SDK session resume; v0.2 will fix this).
4. `query()` from claude-agent-sdk runs the agent loop against the user's `ANTHROPIC_API_KEY`.
5. Each tool call from Claude is proxied via JSON-RPC `tools/call` back to sim's MCP endpoint, which runs sim's existing `executeTool()` registry against sim's own DB. Zero state in mothership-emu.
6. SDK message stream → MothershipStreamV1 SSE: assistant text, thinking, `tool_use` blocks, and `tool_result` blocks all map to sim's wire format.

## Roadmap

- **v0.2 — session persistence**: use SDK `persistSession` + `resume` keyed by sim's `chatId` so multi-turn conversations don't replay tokens.
- **v0.3 — checkpoint/resume**: handle `/api/tools/resume` for human-in-the-loop pauses.
- **v0.4 — chat title gen**: real Claude call instead of echo.
- **v0.5 — proper schema fidelity**: replace the minimal JSON-Schema → Zod converter with a complete one (or upstream tool-typing into the SDK).
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
2. Calls `query()` from claude-agent-sdk with sim's tools registered as an SDK MCP server (via `createSdkMcpServer({ tools: [...] })`); each tool is a proxy that JSON-RPCs `tools/call` back to sim's `/api/mcp/copilot` endpoint
3. Claude (running in the `claude` CLI subprocess) decides to call a tool
4. SDK invokes our proxy handler, which JSON-RPCs to sim and returns the result
5. mothership-emu emits `{type: 'tool', payload: {executor: 'sim', mode: 'sync', name, args}}` then `{type: 'tool', payload: {outcome, result}}` so sim can render both
6. SDK feeds the tool result back into Claude's loop automatically
7. Loop until Claude emits `end_turn` (SDKResultMessage)
8. Emit `{type: 'complete', payload: {}}`

The SDK owning the loop is what makes this small: we don't manage round-trips, we just translate events.

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
