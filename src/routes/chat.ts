/**
 * The LLM brain — receives sim's chat orchestration request and streams Mothership-format
 * events back. v0.1 implementation: claude-agent-sdk + sim's MCP tool catalog.
 *
 * Flow:
 *   1. Parse sim's payload (conversation, model, contexts, etc.)
 *   2. Flatten conversation into a single transcript prompt (v0.1 approach — v0.2 will use
 *      persistSession/resume so multi-turn doesn't replay tokens)
 *   3. Hand to query() with sim's MCP server registered as the tool surface
 *   4. Iterate SDK messages, translate to MothershipStreamV1 SSE events
 *
 * Stub paths (still v0.0.1 behavior — not the focus of v0.1):
 *   - /api/subagent/<id>     : returns "not implemented" — direct tools cover most workflows
 *   - /api/mothership/execute: returns 501 — non-streaming variant, niche
 *   - /api/tools/resume      : returns "not implemented" — checkpoint/resume is v0.3
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../log.ts'
import { getSimMcpServer } from '../sim-tools.ts'

const DEFAULT_MODEL = process.env.MOTHERSHIP_DEFAULT_MODEL ?? 'claude-sonnet-4-6'
const DEFAULT_SYSTEM_PROMPT =
  process.env.MOTHERSHIP_SYSTEM_PROMPT ??
  `You are Sim Copilot, an AI assistant embedded in the Sim workflow automation platform.
You help users build, debug, and operate workflows using the sim_* tools available to you.
When a user asks for something, prefer using tools to inspect or modify their actual workflows
rather than answering hypothetically. Always confirm destructive actions before taking them.`

type SimMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content?: string
  toolCalls?: Array<{ name: string; args: unknown; id?: string }>
  toolCallId?: string
  result?: unknown
}

type SimChatPayload = {
  conversation?: SimMessage[]
  contexts?: unknown[]
  fileAttachments?: unknown[]
  workspaceContext?: { id?: string; name?: string }
  userPermission?: string
  userTimezone?: string
  model?: string
  messageId?: string
  chatId?: string
  executionId?: string
  runId?: string
}

export async function handleChatRoute(req: Request, path: string, requestId: string): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  if (path.startsWith('/api/subagent/')) {
    logger.warn('subagent endpoint not implemented', { requestId, path })
    return sseStub(
      'mothership-emu v0.1 does not implement subagents (sim_workflow, sim_research, etc.). ' +
        'Use the direct tools instead — Claude can compose them to do anything subagents do.',
      requestId,
    )
  }

  if (path === '/api/mothership/execute') {
    logger.warn('mothership execute not implemented', { requestId })
    return Response.json(
      { success: false, error: 'mothership-emu v0.1 does not implement /api/mothership/execute yet' },
      { status: 501 },
    )
  }

  if (path === '/api/tools/resume') {
    logger.warn('tools/resume not implemented', { requestId })
    return sseStub('mothership-emu v0.1 does not implement checkpoint/resume yet (v0.3)', requestId)
  }

  let payload: SimChatPayload
  try {
    payload = (await req.json()) as SimChatPayload
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  logger.info('chat request', {
    requestId,
    path,
    chatId: payload.chatId,
    model: payload.model ?? DEFAULT_MODEL,
    turns: payload.conversation?.length ?? 0,
  })

  const transcript = flattenConversation(payload)
  const model = payload.model ?? DEFAULT_MODEL

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: { type: string; payload: unknown }) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
      }

      send({ type: 'session', payload: { id: requestId, model } })

      try {
        const simServer = await getSimMcpServer()
        const q = query({
          prompt: transcript,
          options: {
            model,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            // createSdkMcpServer already returns { type: 'sdk', name, instance }, so pass it through directly.
            mcpServers: { sim: simServer },
            // Deny everything except the sim tools — no Bash/Read/Write inside the brain.
            allowedTools: [],
            includePartialMessages: false,
          },
        })

        for await (const msg of q) {
          translateSdkMessage(msg as SdkMessageLike, send)
        }

        send({ type: 'complete', payload: {} })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('chat brain crashed', { requestId, error: message })
        send({ type: 'error', payload: { message } })
        send({ type: 'complete', payload: {} })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Flatten sim's conversation array into a single transcript prompt. v0.1 trade-off:
 * we replay the full history on every turn instead of using SDK session persistence.
 * Costs more tokens but is stateless and matches sim's own request shape, so we don't
 * have to maintain a chatId→sessionId map yet.
 */
function flattenConversation(payload: SimChatPayload): string {
  const parts: string[] = []

  if (payload.workspaceContext?.name) {
    parts.push(`# Workspace: ${payload.workspaceContext.name} (id: ${payload.workspaceContext.id ?? 'unknown'})`)
  }
  if (payload.userTimezone) {
    parts.push(`User timezone: ${payload.userTimezone}`)
  }
  if (payload.contexts && payload.contexts.length > 0) {
    parts.push(`Attached contexts: ${JSON.stringify(payload.contexts)}`)
  }

  const conv = payload.conversation ?? []
  // The user's latest message is always the last user-role turn — extract it as the
  // "current ask" so Claude doesn't think prior turns are still pending.
  let lastUserIdx = -1
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx > 0) {
    parts.push('## Prior conversation')
    for (let i = 0; i < lastUserIdx; i++) {
      const turn = conv[i]
      if (turn) parts.push(formatTurn(turn))
    }
    parts.push('## Current request')
    const current = conv[lastUserIdx]
    if (current) parts.push(formatTurn(current))
  } else if (lastUserIdx === 0) {
    const turn = conv[0]
    if (turn) parts.push(formatTurn(turn))
  } else {
    parts.push('(no user message in conversation)')
  }

  return parts.join('\n\n')
}

function formatTurn(turn: SimMessage): string {
  if (turn.role === 'tool') {
    return `[tool result for ${turn.toolCallId ?? '?'}]: ${JSON.stringify(turn.result ?? null)}`
  }
  const tag = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Assistant' : 'System'
  let body = turn.content ?? ''
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    body += `\n[tool calls: ${turn.toolCalls.map((t) => t.name).join(', ')}]`
  }
  return `${tag}: ${body}`
}

/**
 * Map a single SDK message into one or more MothershipStreamV1 events.
 *
 * SDK SDKAssistantMessage.message is the Anthropic Beta Message — a content array of
 * text/tool_use blocks. We split text vs tool_use and emit accordingly. SDKResultMessage
 * carries usage/cost; we surface those on `complete` rather than emitting a separate event,
 * because sim already has its own complete handler.
 */
type SdkMessageLike = {
  type?: string
  message?: { content?: unknown }
  total_cost_usd?: number
  usage?: unknown
  subtype?: string
}

function translateSdkMessage(
  msg: SdkMessageLike,
  send: (event: { type: string; payload: unknown }) => void,
) {
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown; thinking?: string; id?: string }>) {
      if (block.type === 'text' && block.text) {
        send({ type: 'text', payload: { channel: 'assistant', content: block.text } })
      } else if (block.type === 'thinking' && block.thinking) {
        send({ type: 'text', payload: { channel: 'thinking', content: block.thinking } })
      } else if (block.type === 'tool_use') {
        send({
          type: 'tool',
          payload: {
            executor: 'sim',
            mode: 'sync',
            name: block.name,
            args: block.input,
            id: block.id,
          },
        })
      }
    }
    return
  }

  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    // Tool results from the SDK side — emit so sim can render the outcome inline.
    for (const block of msg.message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type === 'tool_result') {
        send({
          type: 'tool',
          payload: {
            executor: 'sim',
            mode: 'sync',
            outcome: block.is_error ? 'error' : 'success',
            id: block.tool_use_id,
            result: block.content,
          },
        })
      }
    }
    return
  }

  if (msg.type === 'result') {
    // Surface cost/usage on a final text in case the panel renders it; keep it small.
    if (typeof msg.total_cost_usd === 'number') {
      logger.info('chat complete', { cost: msg.total_cost_usd, usage: msg.usage })
    }
    return
  }
}

function sseStub(message: string, requestId: string): Response {
  const enc = new TextEncoder()
  const events = [
    { type: 'session', payload: { id: requestId } },
    { type: 'error', payload: { message } },
    { type: 'complete', payload: {} },
  ]
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(enc.encode(body), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
