/**
 * Auxiliary endpoints sim hits but that are non-critical.
 *
 * Most of these are nice-to-have features (chat title generation, model picker, telemetry
 * sinks). Stubbing them with sensible defaults keeps the in-app Copilot panel working
 * without ever blocking on sim.ai infrastructure.
 */
import { logger } from '../log.ts'

export async function handleMiscRoute(req: Request, path: string, requestId: string): Promise<Response> {
  logger.info('misc route hit', { requestId, path, method: req.method })

  // /api/generate-chat-title — generate a short title for a new chat thread.
  // Stub: just return a generic title; ideally call Claude with a tiny prompt.
  if (path === '/api/generate-chat-title') {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const fallback = (body?.message as string)?.slice(0, 40) || 'New chat'
    return Response.json({ title: fallback })
  }

  // /api/get-available-models — sim's UI shows a model picker. Return our claude lineup.
  if (path === '/api/get-available-models') {
    return Response.json({
      models: [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', tier: 'opus' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', tier: 'sonnet' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', tier: 'haiku' },
      ],
    })
  }

  // /api/chats/fork — fork an existing chat (sim feature). Just return a no-op success;
  // the sim-side patched chat persistence already handles the actual fork in DB.
  if (path === '/api/chats/fork') {
    return Response.json({ success: true })
  }

  // /api/streams/explicit-abort — sim notifies us that a stream was aborted. Ack.
  if (path === '/api/streams/explicit-abort') {
    return Response.json({ acked: true })
  }

  // /api/stats, /api/tasks/cleanup, /api/tool-preferences/auto-allowed, /api/traces
  // Telemetry / preference sinks. Return empty success — we don't store anything.
  return Response.json({ ok: true })
}
