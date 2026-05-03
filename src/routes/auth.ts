/**
 * Auth/key management endpoints.
 *
 * Sim's stock code calls these to validate Copilot API keys and to generate/list/delete
 * them. On a properly-patched self-hosted sim, these are already handled locally (see
 * NextLevelManagementAdvisors/sim feature/expose-direct-tools-via-mcp branch). So
 * mothership-emu just needs to NOT be reached for these — but we stub them anyway in case
 * a stock sim install points SIM_AGENT_API_URL at us.
 *
 * The patched sim's authenticateCopilotApiKey does a local keyHash lookup before calling
 * here, so these stubs only fire on a key that's not in the local api_key table.
 */
import { logger } from '../log.ts'

export async function handleAuthRoute(req: Request, path: string, requestId: string): Promise<Response> {
  logger.info('auth route hit', { requestId, path })

  // /api/validate-key — sim sends { targetApiKey } and expects { ok, userId }.
  // Without a way to validate locally (we don't share sim's DB), reject and let sim's
  // local-first lookup own this surface.
  if (path === '/api/validate-key') {
    return Response.json(
      { ok: false, message: 'validate-key handled locally by patched sim — this stub should not be reached' },
      { status: 401 },
    )
  }

  // /api/validate-key/generate, /api/validate-key/delete, /api/validate-key/get-api-keys
  // All handled locally on patched sim. Return 410 to make the misconfig obvious.
  return Response.json(
    {
      error: 'mothership-emu does not implement key management',
      hint: 'Apply the local-Copilot-Keys patch to sim (see NextLevelManagementAdvisors/sim main branch)',
    },
    { status: 410 },
  )
}
