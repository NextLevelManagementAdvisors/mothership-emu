/**
 * Mothership-emu — self-hosted replacement for sim.ai's hosted Mothership/Copilot service.
 *
 * Sim self-hosters set SIM_AGENT_API_URL=http://mothership-emu:3040 in their .env to point
 * sim's copilot lifecycle code at this server instead of copilot.sim.ai. Sim then sends the
 * same Mothership-protocol POST requests it would send to sim.ai; we serve them locally
 * using the user's BYOK Anthropic key (or whatever LLM provider) via the Anthropic Claude
 * Agent SDK.
 *
 * STATUS: SKELETON. Endpoints below are stubs. See README.md for the implementation roadmap.
 */
import { handleAuthRoute } from './routes/auth.ts'
import { handleChatRoute } from './routes/chat.ts'
import { handleMiscRoute } from './routes/misc.ts'
import { logger } from './log.ts'

const PORT = Number(process.env.PORT ?? 3040)
const HOST = process.env.HOST ?? '127.0.0.1'

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const requestId = crypto.randomUUID().slice(0, 8)

    logger.info('request', { requestId, method: req.method, path })

    try {
      // Auth/key management — local DB-backed in sim already, but Mothership has its own
      if (path === '/api/validate-key' || path.startsWith('/api/validate-key/')) {
        return await handleAuthRoute(req, path, requestId)
      }

      // Chat / orchestration — the LLM brain
      if (
        path === '/api/copilot' ||
        path === '/api/mothership' ||
        path === '/api/mothership/execute' ||
        path.startsWith('/api/subagent/') ||
        path === '/api/tools/resume'
      ) {
        return await handleChatRoute(req, path, requestId)
      }

      // Auxiliary endpoints
      if (
        path === '/api/generate-chat-title' ||
        path === '/api/get-available-models' ||
        path === '/api/chats/fork' ||
        path === '/api/streams/explicit-abort' ||
        path === '/api/stats' ||
        path === '/api/tasks/cleanup' ||
        path === '/api/tool-preferences/auto-allowed' ||
        path === '/api/traces'
      ) {
        return await handleMiscRoute(req, path, requestId)
      }

      // Health
      if (path === '/health') {
        return Response.json({ status: 'ok', name: 'mothership-emu', version: '0.0.1' })
      }

      logger.warn('unknown route', { requestId, path })
      return new Response('not found', { status: 404 })
    } catch (err) {
      logger.error('handler crashed', { requestId, error: err instanceof Error ? err.message : String(err) })
      return Response.json({ error: 'internal error', requestId }, { status: 500 })
    }
  },
})

logger.info('mothership-emu listening', { url: `http://${HOST}:${PORT}` })
// Avoid unused-var lint while keeping the handle visible for future graceful-shutdown wiring
void server
