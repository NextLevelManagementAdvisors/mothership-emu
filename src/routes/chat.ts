/**
 * The LLM brain — receives sim's chat orchestration request and streams Mothership-format
 * events back. THIS IS THE BIG ONE.
 *
 * Sim hits one of:
 *   POST /api/copilot                  — main chat (workflow-scoped)
 *   POST /api/mothership               — main chat (workspace-scoped)
 *   POST /api/mothership/execute       — non-streaming Mothership block execution
 *   POST /api/subagent/<id>            — recursive sub-agent invocation
 *   POST /api/tools/resume             — resume after a paused tool execution
 *
 * Request payload (Mothership protocol; reverse-engineered from sim/lib/copilot/chat/post.ts):
 *   {
 *     conversation: [...],            // chat history with roles + tool calls
 *     contexts: [...],                // resource pointers (workflow, files, KB, etc.)
 *     fileAttachments: [...],
 *     userPermission: '...',
 *     userTimezone: '...',
 *     workspaceContext: {...},        // workspace metadata for tool dispatch
 *     // ...plus sim-side metadata: chatId, executionId, runId, messageId
 *   }
 *
 * Response: SSE stream of MothershipStreamV1 events:
 *   { type: 'session', payload: {...} }       // initial handshake
 *   { type: 'text', payload: {channel: 'assistant'|'thinking', content: '...'} }
 *   { type: 'tool', payload: {executor: 'sim'|'go'|'client', name, args, mode, outcome, result?} }
 *   { type: 'span', payload: {kind: 'subagent'|'subagent_result'|'structured_result', ...} }
 *   { type: 'resource', payload: {op: 'upsert'|'remove', ...} }
 *   { type: 'run', payload: {kind: 'checkpoint_pause'|'resumed'|'compaction_start'|'compaction_done'} }
 *   { type: 'error', payload: {message, code?} }
 *   { type: 'complete', payload: {usage?, cost?} }
 *
 * Implementation plan (see README.md for full roadmap):
 *   1. Parse incoming payload — extract messages, system prompt, tool defs
 *   2. Use @anthropic-ai/claude-agent-sdk's query() to run the agent loop:
 *      - Pass tools (sim's 43 direct tool defs, exposed via the patched sim/api/mcp/copilot
 *        endpoint OR fetched via a registry endpoint we'd add to sim)
 *      - Tool handlers proxy back to sim via /api/copilot/tool/execute (sim's existing
 *        callback path) — sim already handles the local executeTool dispatch
 *   3. Translate SDK output (async iterable of message events) to Mothership stream events
 *   4. Stream via SSE
 *
 * Subagent endpoints (`/api/subagent/<id>`) — drop in v0.1; sim's claude.ai/Copilot
 * conversations rarely need the recursive subagent layer when the LLM has direct access to
 * all 43 primitive tools. Revisit if real workflows can't be built without sim_workflow etc.
 */
import { logger } from '../log.ts'

export async function handleChatRoute(req: Request, path: string, requestId: string): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  // Subagent endpoints — drop in v0.1
  if (path.startsWith('/api/subagent/')) {
    logger.warn('subagent endpoint not implemented', { requestId, path })
    const errorEvent = encodeSSE({
      type: 'error',
      payload: {
        message:
          'mothership-emu v0.0.1 does not implement subagents (sim_workflow, sim_research, etc.). ' +
          'Use the direct tools instead.',
      },
    })
    const completeEvent = encodeSSE({ type: 'complete', payload: {} })
    return sseResponse(`${errorEvent}${completeEvent}`)
  }

  // Mothership/execute — non-streaming variant
  if (path === '/api/mothership/execute') {
    logger.warn('mothership execute not implemented', { requestId })
    return Response.json(
      { success: false, error: 'mothership-emu v0.0.1 does not implement /api/mothership/execute yet' },
      { status: 501 },
    )
  }

  // Main chat path — this is what we'll fully implement first
  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  logger.info('chat request received', {
    requestId,
    path,
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload as object) : [],
  })

  // v0.0.1 STUB: return an immediate text + complete event that says we're alive but unimplemented.
  // Real implementation: hand to claude-agent-sdk's query() with tool defs from sim.
  const sessionEvent = encodeSSE({ type: 'session', payload: { id: requestId } })
  const textEvent = encodeSSE({
    type: 'text',
    payload: {
      channel: 'assistant',
      content:
        'mothership-emu is online but the chat brain is not implemented yet (v0.0.1 skeleton). ' +
        'See https://github.com/NextLevelManagementAdvisors/mothership-emu — patches welcome.',
    },
  })
  const completeEvent = encodeSSE({ type: 'complete', payload: {} })

  return sseResponse(`${sessionEvent}${textEvent}${completeEvent}`)
}

function encodeSSE(event: { type: string; payload: unknown }): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
