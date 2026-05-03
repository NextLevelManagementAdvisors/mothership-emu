/**
 * The LLM brain — receives sim's chat request and streams MothershipStreamV1 events back.
 *
 * Wire contract (reverse-engineered from sim's source — see notes below):
 *
 * **Request from sim**: POST /api/copilot or /api/mothership with body:
 *   {
 *     message: string,                    // the new user message
 *     workspaceId?, workflowId?, userId,
 *     mode: 'agent' | 'ask',
 *     model?, provider?,
 *     messageId: string,                  // sim uses this as the streamId
 *     chatId?: string,                    // we key history by this
 *     context?: Array<{type, content}>,
 *     integrationTools?: Array<{...}>,    // tool catalog from sim's side
 *     workspaceContext?, userPermission?, userTimezone?,
 *     isHosted: boolean,
 *   }
 *   Note: sim does NOT send conversation history. Mothership maintains state per chatId.
 *
 * **Response to sim**: SSE stream of envelope-wrapped events. Each event MUST have:
 *   {
 *     v: 1,
 *     seq: <incrementing number>,
 *     ts: <ISO timestamp>,
 *     stream: { streamId, chatId?, cursor? },
 *     trace?: { requestId },
 *     type: 'session' | 'text' | 'tool' | 'complete' | 'error',
 *     payload: <type-specific shape — see MothershipStreamV1*Payload>,
 *   }
 *   Sim's parsePersistedStreamEventEnvelope strictly validates this shell. Without v=1 + seq
 *   + ts + stream.streamId, the event is rejected with "unexpected v=undefined".
 *
 * **Payload shapes**:
 *   - text:    { channel: 'assistant'|'thinking', text }     (note: `text`, NOT `content`)
 *   - tool call: { phase: 'call', toolCallId, toolName, executor: 'sim', mode: 'sync', arguments? }
 *   - tool result: { phase: 'result', toolCallId, toolName, executor: 'sim', mode: 'sync',
 *                    success: bool, output?, error? }
 *   - complete: { status: 'complete' | 'error' | 'cancelled' }
 *   - error:   { message: string, error?, displayMessage? }
 *
 * History strategy (v0.1.1): in-memory Map<chatId, Array<{role, content}>>. The history is
 * rebuilt into a single transcript prompt on each request. v0.2 will switch to SDK
 * persistSession+resume keyed by chatId so we don't re-tokenize history every turn.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../log.ts'
import { getSimMcpServer } from '../sim-tools.ts'

const DEFAULT_MODEL = process.env.MOTHERSHIP_DEFAULT_MODEL ?? 'claude-sonnet-4-6'
const CLAUDE_BINARY_PATH =
  process.env.CLAUDE_CODE_BINARY ??
  '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
const DEFAULT_SYSTEM_PROMPT =
  process.env.MOTHERSHIP_SYSTEM_PROMPT ??
  `You are Sim Copilot, an AI assistant embedded in the Sim workflow automation platform.
You help users build, debug, and operate workflows using the sim_* tools available to you.
When a user asks for something, prefer using tools to inspect or modify their actual workflows
rather than answering hypothetically. Always confirm destructive actions before taking them.`

type SimChatPayload = {
  message?: string
  workspaceId?: string
  workflowId?: string
  workflowName?: string
  userId?: string
  model?: string
  provider?: string
  mode?: string
  messageId?: string
  chatId?: string
  context?: unknown
  integrationTools?: unknown
  workspaceContext?: { id?: string; name?: string }
  userPermission?: string
  userTimezone?: string
  isHosted?: boolean
}

type ChatTurn = { role: 'user' | 'assistant'; content: string }

const chatHistory = new Map<string, ChatTurn[]>()
const HISTORY_MAX_TURNS = 40

function rememberTurn(chatId: string | undefined, turn: ChatTurn) {
  if (!chatId) return
  const prior = chatHistory.get(chatId) ?? []
  prior.push(turn)
  while (prior.length > HISTORY_MAX_TURNS) prior.shift()
  chatHistory.set(chatId, prior)
}

export async function handleChatRoute(req: Request, path: string, requestId: string): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  if (path.startsWith('/api/subagent/')) {
    logger.warn('subagent endpoint not implemented', { requestId, path })
    return sseStub('mothership-emu v0.1 does not implement subagents (sim_workflow, sim_research, etc.).', requestId)
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

  const message = (payload.message ?? '').trim()
  const chatId = payload.chatId
  const streamId = payload.messageId ?? requestId
  const model = payload.model || DEFAULT_MODEL

  logger.info('chat request', {
    requestId,
    path,
    chatId,
    streamId,
    model,
    workspaceId: payload.workspaceId,
    msgLength: message.length,
  })

  const transcript = buildTranscript(chatId, message, payload)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      let seq = 0
      let streamClosed = false
      // Guard enqueue: if the client disconnects mid-stream the controller closes, but the
      // SDK loop keeps emitting events. Without this guard each subsequent send() throws
      // "Invalid state: Controller is already closed" and trashes the request handler.
      const send = (type: string, payloadObj: unknown) => {
        if (streamClosed) return
        const event = {
          v: 1,
          seq: ++seq,
          ts: new Date().toISOString(),
          stream: { streamId, ...(chatId ? { chatId } : {}), cursor: String(seq) },
          trace: { requestId },
          type,
          payload: payloadObj,
        }
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          streamClosed = true
        }
      }

      // Session 'start' so sim sees an immediate handshake.
      send('session', { kind: 'start' })
      if (chatId) send('session', { kind: 'chat', chatId })

      let assistantText = ''
      let completeStatus: 'complete' | 'error' | 'cancelled' = 'complete'

      try {
        const simServer = await getSimMcpServer()
        const q = query({
          prompt: transcript,
          options: {
            model,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
            mcpServers: { sim: simServer },
            tools: [],
            canUseTool: async (toolName, input) => {
              logger.info('auto-approving tool', { tool: toolName })
              return { behavior: 'allow', updatedInput: input }
            },
            includePartialMessages: false,
          },
        })

        for await (const msg of q) {
          assistantText += translateSdkMessage(msg as SdkMessageLike, send)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('chat brain crashed', { requestId, error: message })
        send('error', { message, displayMessage: 'Mothership-emu encountered an error.' })
        completeStatus = 'error'
      }

      if (assistantText && chatId) {
        rememberTurn(chatId, { role: 'user', content: message })
        rememberTurn(chatId, { role: 'assistant', content: assistantText })
      }

      send('complete', { status: completeStatus })
      if (!streamClosed) {
        try {
          controller.close()
        } catch {
          // already closed
        }
        streamClosed = true
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
 * Replay prior turns + the new user message into a single transcript prompt. v0.1.1
 * trade-off: re-tokenizes history each turn. v0.2 will use SDK persistSession+resume
 * so this becomes unnecessary.
 */
function buildTranscript(chatId: string | undefined, message: string, payload: SimChatPayload): string {
  const parts: string[] = []
  if (payload.workspaceContext?.name) {
    parts.push(`# Workspace: ${payload.workspaceContext.name} (id: ${payload.workspaceContext.id ?? 'unknown'})`)
  }
  if (payload.userTimezone) parts.push(`User timezone: ${payload.userTimezone}`)

  const prior = chatId ? chatHistory.get(chatId) : undefined
  if (prior && prior.length > 0) {
    parts.push('## Prior conversation')
    for (const turn of prior) {
      parts.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    }
    parts.push('## Current request')
  }

  parts.push(message || '(empty message)')
  return parts.join('\n\n')
}

type SdkMessageLike = {
  type?: string
  message?: { content?: unknown }
  total_cost_usd?: number
  usage?: unknown
  subtype?: string
}

/**
 * Translate one SDK message into MothershipStreamV1 events. Returns the assistant text
 * portion (so the caller can persist it for history rebuilding next turn).
 */
function translateSdkMessage(msg: SdkMessageLike, send: (type: string, payload: unknown) => void): string {
  let assistantText = ''

  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content as Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      thinking?: string
      id?: string
    }>) {
      if (block.type === 'text' && block.text) {
        send('text', { channel: 'assistant', text: block.text })
        assistantText += block.text
      } else if (block.type === 'thinking' && block.thinking) {
        send('text', { channel: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use' && block.id && block.name) {
        send('tool', {
          phase: 'call',
          toolCallId: block.id,
          toolName: block.name,
          executor: 'sim',
          mode: 'sync',
          arguments: (block.input ?? {}) as Record<string, unknown>,
        })
      }
    }
    return assistantText
  }

  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content as Array<{
      type: string
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }>) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        send('tool', {
          phase: 'result',
          toolCallId: block.tool_use_id,
          toolName: '',
          executor: 'sim',
          mode: 'sync',
          success: !block.is_error,
          output: block.content,
          ...(block.is_error ? { error: 'Tool execution failed' } : {}),
        })
      }
    }
    return ''
  }

  if (msg.type === 'result') {
    if (typeof msg.total_cost_usd === 'number') {
      logger.info('chat complete', { cost: msg.total_cost_usd, usage: msg.usage })
    }
    return ''
  }

  return ''
}

function sseStub(message: string, requestId: string): Response {
  const enc = new TextEncoder()
  let seq = 0
  const wrap = (type: string, payload: unknown) =>
    `data: ${JSON.stringify({
      v: 1,
      seq: ++seq,
      ts: new Date().toISOString(),
      stream: { streamId: requestId, cursor: String(seq) },
      trace: { requestId },
      type,
      payload,
    })}\n\n`
  const body =
    wrap('session', { kind: 'start' }) +
    wrap('error', { message, displayMessage: message }) +
    wrap('complete', { status: 'error' })
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
