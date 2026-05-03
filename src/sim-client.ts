/**
 * JSON-RPC client for sim's MCP endpoint at ${SIM_BASE_URL}/api/mcp/copilot.
 *
 * Sim already speaks MCP for its Copilot tool surface — list and call. We use that as our
 * tool dispatch layer rather than inventing a new HTTP callback path. Sim's MCP route runs
 * the same executeTool() registry the in-app Copilot uses, so semantics match exactly.
 */
import { logger } from './log.ts'

const SIM_BASE_URL = process.env.SIM_BASE_URL ?? 'http://simstudio:3000'
const SIM_API_KEY = process.env.SIM_INTERNAL_API_KEY ?? ''

if (!SIM_API_KEY) {
  logger.warn('SIM_INTERNAL_API_KEY not set — tool calls will fail')
}

export type McpTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

type JsonRpcResponse<T> =
  | { jsonrpc: '2.0'; id: number; result: T }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string; data?: unknown } }

let rpcId = 0

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const id = ++rpcId
  const res = await fetch(`${SIM_BASE_URL}/api/mcp/copilot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': SIM_API_KEY,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (!res.ok) {
    throw new Error(`sim mcp ${method} returned ${res.status}: ${await res.text()}`)
  }
  // Sim's MCP endpoint may respond with SSE wrapping for streaming compat; unwrap if so.
  const ct = res.headers.get('content-type') ?? ''
  let body: unknown
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) throw new Error(`sim mcp ${method} sse had no data line`)
    body = JSON.parse(dataLine.slice(6))
  } else {
    body = await res.json()
  }
  const parsed = body as JsonRpcResponse<T>
  if ('error' in parsed) {
    throw new Error(`sim mcp ${method} error ${parsed.error.code}: ${parsed.error.message}`)
  }
  return parsed.result
}

export async function listSimTools(): Promise<McpTool[]> {
  const result = await rpc<{ tools: McpTool[] }>('tools/list', {})
  return result.tools
}

export async function callSimTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  return rpc('tools/call', { name, arguments: args })
}
