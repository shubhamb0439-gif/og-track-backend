/**
 * Central tool registry. This is the "extend by registering, not by editing
 * the engine" seam: a new module's tool file calls registerTools([...]) and
 * those tools are immediately visible to AIDA for every tenant that has the
 * matching module(s) enabled — nothing else in src/aida/ changes.
 *
 * A tool looks like:
 *   {
 *     name: 'attendance_get_late_employees',   // unique, snake_case, stable (shown to the LLM)
 *     description: '...',                       // what it does + when to use it (shown to the LLM)
 *     requiredModules: ['attendance'] | null,    // null/[] = always available (e.g. HR employees list)
 *     inputSchema: { type: 'object', properties: {...}, required: [...] }, // JSON Schema
 *     handler: async (context, args) => {...}    // does the work via apiClient, returns plain JSON
 *   }
 */

const { MASTERADMIN_SENTINEL_MODULE } = require('./contextBuilder');

const tools = new Map();

function registerTool(tool) {
  if (!tool || !tool.name) throw new Error('Tool must have a name');
  if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
  tools.set(tool.name, {
    requiredModules: [],
    inputSchema: { type: 'object', properties: {} },
    ...tool,
  });
}

function registerTools(list) {
  list.forEach(registerTool);
}

/**
 * A tool is available if:
 * - it's a master-admin tool (requires the '__masteradmin__' sentinel) AND this is a master-admin context, or
 * - it's a tenant tool (anything else) AND this is a tenant context, AND it either has no module
 *   requirement or the tenant has ANY one of the listed modules enabled.
 * This keeps master-admin-only tools from leaking into a tenant chat (and vice versa) even though
 * both live in the same registry — a module-less tenant tool like hr_get_employees would otherwise
 * look "always available" and wrongly show up for master admin, where there's no tenant to call.
 */
function isAvailable(tool, context) {
  const required = tool.requiredModules || [];
  const isMasterAdminTool = required.includes(MASTERADMIN_SENTINEL_MODULE);
  if (context.kind === 'masteradmin') return isMasterAdminTool;
  if (isMasterAdminTool) return false;
  if (required.length === 0) return true;
  return required.some((m) => (context.enabledModules || []).includes(m));
}

/** Tools visible to this context — scoped by enabled_modules, exactly like the rest of OG Track. */
function listAvailableTools(context) {
  return [...tools.values()].filter((t) => isAvailable(t, context));
}

/** Anthropic tool-use schema for every tool this context can see. */
function toAnthropicTools(context) {
  return listAvailableTools(context).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** OpenAI function-calling schema for every tool this context can see (same JSON Schema, different wrapper). */
function toOpenAITools(context) {
  return listAvailableTools(context).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// Some underlying OG Track endpoints return an entire table with no limit
// (e.g. inventory items for a company with 900+ rows is ~400KB of JSON,
// ~100k tokens — found by testing against real Cajo data, and it blew past
// the account's whole per-request rate limit on its own, unrelated to
// conversation history or which provider is configured). This is a generic
// safety net so no CURRENT or FUTURE tool can do this — it caps whichever
// array field is largest rather than needing every tool file to remember to
// paginate itself.
const MAX_RESULT_CHARS = 15_000;

function truncateResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (JSON.stringify(result).length <= MAX_RESULT_CHARS) return result;

  let largestKey = null;
  let largestLen = -1;
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length > largestLen) {
      largestKey = key;
      largestLen = value.length;
    }
  }
  if (!largestKey) {
    // No array field to trim (a single huge object/string) — rare, but
    // don't ship an unbounded payload regardless of shape.
    return { _truncated: true, _note: 'Result was too large to return in full.' };
  }

  const original = result[largestKey];
  let keep = original.length;
  let candidate = original;
  while (keep > 1) {
    keep = Math.max(1, Math.floor(keep / 2));
    candidate = original.slice(0, keep);
    if (JSON.stringify({ ...result, [largestKey]: candidate }).length <= MAX_RESULT_CHARS) break;
  }
  return {
    ...result,
    [largestKey]: candidate,
    _truncated: true,
    _note: `Showing ${candidate.length} of ${original.length} total "${largestKey}" — the full result was too large to return. Ask a more specific/filtered question (by status, date range, id, etc.) to see the rest.`,
  };
}

async function executeTool(name, args, context) {
  const tool = tools.get(name);
  if (!tool) return { error: `Unknown tool "${name}".` };
  if (!isAvailable(tool, context)) {
    return { error: `This company does not have the module required for "${name}" enabled.` };
  }
  try {
    const result = await tool.handler(context, args || {});
    return truncateResult(result);
  } catch (e) {
    return { error: e.message || 'Tool execution failed.' };
  }
}

function _reset() {
  tools.clear();
} // test-only escape hatch

module.exports = { registerTool, registerTools, listAvailableTools, toAnthropicTools, toOpenAITools, executeTool, _reset };
