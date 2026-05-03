/**
 * Bridge sim's tool surface into a claude-agent-sdk MCP server.
 *
 * Two tool sources combine into one MCP server per chat request:
 *
 *  1. **Management tools** (cached). Fetched ONCE at startup via JSON-RPC `tools/list`
 *     against sim's `/api/mcp/copilot`. These are sim's meta tools — workflow CRUD,
 *     deployment, credentials, MCP server publishing, etc. ~40 tools, stable across
 *     requests.
 *
 *  2. **Integration tools** (per-request). Sim sends an `integrationTools` array in the
 *     chat payload, listing every connected integration the user has set up (Gmail,
 *     Google Calendar, Slack, Twilio, etc.). These vary per user/workspace and per
 *     request; we register them fresh on each chat call.
 *
 * Both kinds dispatch through the same `/api/mcp/copilot` endpoint via JSON-RPC
 * `tools/call`. The integration-tool dispatch path requires the sim patch that lets
 * `handleToolsCall` fall through to `executeTool` for any unknown tool name (commit
 * `feat(mcp): allow MCP tool dispatch to fall through to integration tools`).
 *
 * JSON Schema → Zod conversion handles the schema features sim's catalog actually uses
 * (string, number, boolean, object, array, enum, optional, anyOf/oneOf). Anything
 * exotic falls back to `z.unknown()` so the tool still works, just with looser typing.
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

/**
 * Sim's integration tool descriptor (from `buildIntegrationToolSchemas` in
 * apps/sim/lib/copilot/chat/payload.ts). Note `input_schema` is snake_case here,
 * unlike the MCP tools/list response which uses `inputSchema`.
 */
export type IntegrationToolDef = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  defer_loading?: boolean
  executeLocally?: boolean
  oauth?: { required: boolean; provider?: string }
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

function buildShapeFromJsonSchema(rawSchema: Record<string, unknown> | undefined): ZodShape {
  const schema = (rawSchema ?? {}) as JsonSchema
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const shape: ZodShape = {}
  for (const [key, prop] of Object.entries(props)) {
    let field = jsonSchemaToZod(prop)
    if (prop.description) field = field.describe(prop.description)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return shape
}

function buildToolFromMcp(mcp: McpTool) {
  const description = mcp.description?.trim() || `sim tool: ${mcp.name}`
  const annotations = (mcp.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined) ?? {}
  return tool(
    mcp.name,
    description,
    buildShapeFromJsonSchema(mcp.inputSchema),
    async (args) => proxyToolCall(mcp.name, args as Record<string, unknown>),
    { annotations },
  )
}

function buildToolFromIntegration(def: IntegrationToolDef) {
  const description = def.description?.trim() || `integration tool: ${def.name}`
  return tool(
    def.name,
    description,
    buildShapeFromJsonSchema(def.input_schema),
    async (args) => proxyToolCall(def.name, args as Record<string, unknown>),
  )
}

async function proxyToolCall(name: string, args: Record<string, unknown>) {
  logger.info('proxying tool call to sim', { tool: name })
  try {
    const result = await callSimTool(name, args)
    return {
      content: result.content as Array<{ type: 'text'; text: string }>,
      isError: result.isError,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('sim tool call failed', { tool: name, error: message })
    return {
      content: [{ type: 'text' as const, text: `tool ${name} failed: ${message}` }],
      isError: true,
    }
  }
}

/**
 * Sim's `sim_*` tools (sim_workflow, sim_auth, sim_research, sim_superagent, etc.) are
 * subagent meta-tools, not flat primitives. When dispatched they round-trip back to
 * mothership at /api/subagent/<id>, which we don't implement (v1.0). Filter them out so
 * Claude only sees the direct tools.
 */
function isDirectTool(name: string): boolean {
  return !name.startsWith('sim_')
}

let cachedManagementTools: McpTool[] | null = null

async function getCachedManagementTools(): Promise<McpTool[]> {
  if (cachedManagementTools) return cachedManagementTools
  const allTools = await listSimTools()
  cachedManagementTools = allTools.filter((t) => isDirectTool(t.name))
  const skipped = allTools.length - cachedManagementTools.length
  logger.info('cached sim management tools', {
    count: cachedManagementTools.length,
    skippedSubagents: skipped,
    names: cachedManagementTools.map((t) => t.name),
  })
  return cachedManagementTools
}

/**
 * Hard cap on how many integration tools we'll register per request. Sim's
 * buildIntegrationToolSchemas returns the FULL catalog (~2500+ tools across every
 * integration block) because the hosted Mothership uses lazy `defer_loading: true`
 * to fetch tool defs on demand. We don't have that infrastructure (yet), so we cap
 * the catalog and prioritize the tools most likely to be useful. Override via env.
 */
const MAX_INTEGRATION_TOOLS = Number(process.env.MOTHERSHIP_MAX_INTEGRATION_TOOLS ?? 100)

/**
 * Prefix priority for the cap: when sim hands us more integration tools than we can
 * fit, we keep these prefixes first (commonly-needed integrations), then fill the
 * rest with whatever else fits. Override via env (comma-separated prefix list).
 */
const PRIORITY_PREFIXES = (
  process.env.MOTHERSHIP_PRIORITY_INTEGRATIONS ??
  'gmail_,googlecalendar_,googledrive_,googledocs_,googlesheets_,slack_,twilio_,notion_,airtable_,hubspot_,salesforce_,linear_,asana_,jira_,github_,discord_,openai_,anthropic_,perplexity_,exa_,firecrawl_,serper_,reddit_,outlook_,microsoftteams_,teams_,confluence_,clickup_,trello_,zendesk_,intercom_,hospitable_,guesty_,airbnb_,stripe_'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function integrationPriority(name: string): number {
  // Lower = more important. Tools without an OAuth requirement, then matching priority
  // prefixes in declared order, then alphabetical.
  for (let i = 0; i < PRIORITY_PREFIXES.length; i++) {
    if (PRIORITY_PREFIXES[i] && name.startsWith(PRIORITY_PREFIXES[i] as string)) return i
  }
  return PRIORITY_PREFIXES.length // unmatched falls to end
}

/**
 * Build a fresh SDK MCP server for one chat request, combining the cached management
 * tools with the per-request integration tools sim included in its payload. Returning a
 * new server per call avoids the lifecycle/transport state-sharing concerns that come
 * with reusing a single McpServer instance across concurrent SDK queries.
 *
 * If sim sends more integration tools than MAX_INTEGRATION_TOOLS, we keep priority
 * tools (gmail/calendar/slack/etc.) first and drop the long tail. Without this cap,
 * 2500+ tool defs blow past Claude's prompt size limit and the chat fails with
 * "Prompt is too long".
 */
export async function buildSimMcpServer(integrationTools: IntegrationToolDef[] = []) {
  const managementTools = await getCachedManagementTools()
  const managementNames = new Set(managementTools.map((m) => m.name))

  // Dedupe by name + drop collisions with management tools (management wins).
  const dedupedIntegrations = new Map<string, IntegrationToolDef>()
  for (const it of integrationTools) {
    if (!it?.name) continue
    if (managementNames.has(it.name)) continue
    if (dedupedIntegrations.has(it.name)) continue
    dedupedIntegrations.set(it.name, it)
  }
  const allIntegrations = Array.from(dedupedIntegrations.values())
  const totalReceived = allIntegrations.length

  // Sort by priority, then alphabetical, then take the top N.
  allIntegrations.sort((a, b) => {
    const pa = integrationPriority(a.name)
    const pb = integrationPriority(b.name)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })
  const keptIntegrations = allIntegrations.slice(0, MAX_INTEGRATION_TOOLS)
  const droppedCount = totalReceived - keptIntegrations.length

  const sdkTools = [
    ...managementTools.map(buildToolFromMcp),
    ...keptIntegrations.map(buildToolFromIntegration),
  ]

  logger.info('built sim mcp server for request', {
    managementCount: managementTools.length,
    integrationCountKept: keptIntegrations.length,
    integrationCountReceived: totalReceived,
    integrationCountDropped: droppedCount,
    cap: MAX_INTEGRATION_TOOLS,
    sampleIntegrationNames: keptIntegrations.slice(0, 20).map((t) => t.name),
  })

  return createSdkMcpServer({
    name: 'sim',
    version: '0.0.1',
    tools: sdkTools,
  })
}

// Allow the management catalog to be re-fetched (e.g. on SIGHUP) once we want hot-reload.
export function invalidateSimToolsCache() {
  cachedManagementTools = null
}
