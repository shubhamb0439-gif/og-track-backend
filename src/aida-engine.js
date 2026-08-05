/**
 * AIDA Engine
 * ============================================================================
 *   User message + context
 *        ↓
 *   Intent + tool selection   (OpenAI function-calling — may pick 0-N tools)
 *        ↓
 *   Tool execution            (real HTTP self-calls, see aida-tools.js)
 *        ↓
 *   Natural-language synthesis (OpenAI, given the tool results as context)
 *        ↓
 *   Text response
 *
 * Session memory: a lightweight in-memory map keyed by `${slug}:${userId}`,
 * holding the last few turns of conversation so follow-up questions like
 * "which one is delayed?" resolve against what was already discussed. This
 * is intentionally NOT persisted to any database — it resets on server
 * restart and is explicitly cleared on logout (see clearSession below) per
 * the requirement not to create permanent AI memory.
 * ============================================================================
 */

const config = require('./config');
const TOOLS = require('./aida-tools');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ── Session memory (in-memory only, per the "no permanent AI memory" requirement) ──
const sessions = new Map(); // key: `${slug}:${userId}` -> [{role, content}, ...]
const MAX_TURNS_KEPT = 8; // keep it lightweight — last few turns only, not full history

function sessionKey(ctx) { return `${ctx.slug}:${ctx.userId}`; }

function getSessionHistory(ctx) {
  return sessions.get(sessionKey(ctx)) || [];
}

function pushToSession(ctx, role, content) {
  const key = sessionKey(ctx);
  const history = sessions.get(key) || [];
  history.push({ role, content });
  while (history.length > MAX_TURNS_KEPT) history.shift();
  sessions.set(key, history);
}

// Called on logout — see the frontend change wiring this into doLogout().
function clearSession(ctx) {
  sessions.delete(sessionKey(ctx));
}

// ── OpenAI call helper ───────────────────────────────────────────────────────
async function callOpenAI(messages, tools) {
  if (!config.aida.openaiApiKey) {
    throw Object.assign(new Error('AIDA is not configured yet — missing OPENAI_API_KEY.'), { status: 503 });
  }
  const body = {
    model: config.aida.openaiModel,
    messages,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
  };
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.aida.openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('AIDA: OpenAI call failed:', data);
    throw new Error('AIDA could not process that request. Please try again.');
  }
  return data.choices[0].message;
}

function toolsToOpenAiSpec() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.params },
  }));
}

function buildSystemPrompt(ctx) {
  // Context awareness per the brief: every request carries user/role/tenant/
  // page context, so the model doesn't need it repeated by the user and so
  // follow-up questions ("why is THIS delayed") resolve against what's
  // currently on screen.
  return [
    'You are AIDA, the conversational assistant for OGTrack.',
    'You answer questions by calling the provided tools, which fetch real data from OGTrack\'s existing APIs — never invent data.',
    'If a tool returns an error (including permission errors), explain plainly to the user what happened; do not expose raw error text or technical details.',
    'Keep responses concise and natural, like a helpful colleague, not a report.',
    '',
    `Current user: ${ctx.userName || ctx.userId} (role: ${ctx.role})`,
    `Company: ${ctx.companyId || ctx.slug}`,
    ctx.currentModule ? `Currently viewing: ${ctx.currentModule}${ctx.currentView ? ' / ' + ctx.currentView : ''}` : '',
    ctx.currentProject ? `Active project/context: ${JSON.stringify(ctx.currentProject)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Main entry point. `ctx` must include: slug, token, userId, userName, role,
 * companyId, currentView, currentModule, currentProject (any of the latter
 * three may be undefined if not applicable to the current screen).
 */
async function handleMessage(ctx, userMessage) {
  const history = getSessionHistory(ctx);
  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Step 1: intent detection + tool selection (may select 0, 1, or several
  // tools in one turn — supports the brief's "company summary" example,
  // where multiple modules' tools all get called for one response).
  const firstReply = await callOpenAI(messages, toolsToOpenAiSpec());

  let toolResults = [];
  if (firstReply.tool_calls && firstReply.tool_calls.length) {
    messages.push(firstReply);
    for (const call of firstReply.tool_calls) {
      const tool = TOOLS.find(t => t.name === call.function.name);
      let result;
      if (!tool) {
        result = { error: `Unknown tool: ${call.function.name}` };
      } else {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { /* leave args empty */ }
        try {
          result = await tool.run(ctx, args);
        } catch (e) {
          // Never let a raw error (including anything that bubbled up from a
          // downstream API, which itself never exposes raw SQL errors) reach
          // the model verbatim beyond a clean message.
          result = { error: e.message || 'This tool could not complete its request.' };
        }
      }
      toolResults.push({ tool: call.function.name, result });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    // Step 2: synthesize a natural-language response now that tool results
    // are available in the conversation.
    const finalReply = await callOpenAI(messages);
    pushToSession(ctx, 'user', userMessage);
    pushToSession(ctx, 'assistant', finalReply.content);
    return { reply: finalReply.content, toolsUsed: toolResults.map(t => t.tool) };
  }

  // No tool was needed (small talk, clarification, etc.)
  pushToSession(ctx, 'user', userMessage);
  pushToSession(ctx, 'assistant', firstReply.content);
  return { reply: firstReply.content, toolsUsed: [] };
}

module.exports = { handleMessage, clearSession };