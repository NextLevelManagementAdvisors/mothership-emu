/**
 * Bridge sim's MCP tool catalog into a claude-agent-sdk MCP server.
 *
 * At process startup we call sim's tools/list once, then register every tool as a
 * proxy: when the SDK invokes the tool, we JSON-RPC tools/call back to sim. This
 * keeps mothership-emu zero-state — sim owns the workflow DB and execution; we just
 * wire Claude's tool-use loop through to sim.
 *
 * JSON Schema → Zod conversion is deliberately minimal: we handle the schema features
 * sim's tool catalog actually uses (string, number, boolean, object, array, enum,
 * required arrays, optionality). Anything exotic falls back to z.unknown() so the
 * tool still works, just with looser typing.
 */
import { z, type ZodTypeAny } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { listSimTools, callSimTool, type McpTool } from './sim-client.ts'
import { logger } from './log.ts'

type ZodShape = Record<string, ZodTypeAny>

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | JsonSchema[]
  enum?: unknown[]
  description?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  default?: unknown
}

function jsonSchemaToZod(schema: JsonSchema): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown()

  if (schema.enum && Array.isArray(schema.enum)) {
    const stringEnum = schema.enum.every((v) => typeof v === 'string')
    if (stringEnum && schema.enum.length > 0) {
      return z.enum(schema.enum as [string, ...string[]])
    }
    return z.union(schema.enum.map((v) => z.literal(v as never)) as never)
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).map(jsonSchemaToZod)
    if (variants.length === 0) return z.unknown()
    const first = variants[0]
    if (variants.length === 1 && first) return first
    if (first && variants[1]) {
      return z.union([first, variants[1], ...variants.slice(2).filter((v): v is ZodTypeAny => !!v)])
    }
    return z.unknown()
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type

  switch (type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array': {
      const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items
      return z.array(itemSchema ? jsonSchemaToZod(itemSchema) : z.unknown())
    }
    case 'object': {
      const shape: ZodShape = {}
      const required = new Set(schema.required ?? [])
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        let field = jsonSchemaToZod(prop)
        if (prop.description) field = field.describe(prop.description)
        if (!required.has(key)) field = field.optional()
        shape[key] = field
      }
      return z.object(shape).loose()
    }
    default:
      return z.unknown()
  }
}

function buildToolFromMcp(mcp: McpTool) {
  const inputSchema = mcp.inputSchema as JsonSchema
  const props = inputSchema.properties ?? {}
  const required = new Set(inputSchema.required ?? [])
  const shape: ZodShape = {}
  for (const [key, prop] of Object.entries(props)) {
    let field = jsonSchemaToZod(prop)
    if (prop.description) field = field.describe(prop.description)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }

  const description = mcp.description?.trim() || `sim tool: ${mcp.name}`
  const annotations = (mcp.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined) ?? {}

  return tool(
    mcp.name,
    description,
    shape,
    async (args) => {
      logger.info('proxying tool call to sim', { tool: mcp.name })
      try {
        const result = await callSimTool(mcp.name, args as Record<string, unknown>)
        return { content: result.content as Array<{ type: 'text'; text: string }>, isError: result.isError }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('sim tool call failed', { tool: mcp.name, error: message })
        return { content: [{ type: 'text' as const, text: `tool ${mcp.name} failed: ${message}` }], isError: true }
      }
    },
    { annotations },
  )
}

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null

export async function getSimMcpServer() {
  if (cachedServer) return cachedServer
  const tools = await listSimTools()
  logger.info('registered sim tools as sdk mcp server', { count: tools.length, names: tools.map((t) => t.name) })
  cachedServer = createSdkMcpServer({
    name: 'sim',
    version: '0.0.1',
    tools: tools.map(buildToolFromMcp),
  })
  return cachedServer
}

// Allow the catalog to be re-fetched (e.g. on SIGHUP) once we want hot-reload.
export function invalidateSimToolsCache() {
  cachedServer = null
}
