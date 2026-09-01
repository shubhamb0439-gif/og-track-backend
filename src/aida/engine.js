const config = require('../config');
const anthropicProvider = require('./providers/anthropic');
const openaiProvider = require('./providers/openai');
const { BASELINE_PROMPT_LINE, AVOID_OPENERS_LINE } = require('./personality');

/** First handful of words of the assistant's most recent reply in this conversation, or null if there isn't one. */
function lastAssistantOpener(history) {
  if (!history || !history.length) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      const words = (history[i].content || '').trim().split(/\s+/).slice(0, 8).join(' ');
      return words || null;
    }
  }
  return null;
}

/**
 * The orchestration engine: intent -> tool selection -> API call -> result
 * -> natural language response. The actual tool-use loop is provider-
 * specific (Anthropic and OpenAI shape tool calls differently), so this
 * file just builds the shared system prompt and dispatches to whichever
 * provider adapter matches config.aida.provider (see src/aida/providers/).
 */

function buildSystemPrompt(context, { history, directive } = {}) {
  const identity =
    context.kind === 'masteradmin'
      ? 'You are AIDA, the AI layer for the OG Track platform, currently assisting a PLATFORM MASTER ADMIN (cross-company, not scoped to one tenant).'
      : `You are AIDA, the AI layer for OG Track, currently assisting a user at "${context.companyName}".`;

  const contextLines = [
    identity,
    '',
    'Current session context (do not ask the user to repeat this):',
    `- User ID: ${context.userId}`,
    `- Role: ${context.role}`,
    context.tenantSlug ? `- Company / tenant slug: ${context.tenantSlug}` : null,
    context.currentPage ? `- Current page: ${context.currentPage}` : null,
    context.currentModule ? `- Current module: ${context.currentModule}` : null,
    context.currentRoute ? `- Current route: ${context.currentRoute}` : null,
    context.activeEntity
      ? `- Active item on screen: ${context.activeEntity.type} "${context.activeEntity.name || context.activeEntity.id}" (id: ${context.activeEntity.id})`
      : null,
    '',
    'Rules:',
    '- You have NO knowledge of OG Track data on your own. Every fact about attendance, projects, CRM, inventory, finance, or HR MUST come from calling a tool. Never guess or invent numbers, names, or statuses.',
    '- CRITICAL: every single time the user asks you to start, check, run, or look up ANYTHING, you MUST issue a real tool call in THIS turn — even if an earlier message in this conversation already asked for something similar. A previous reply is never proof you already handled a new request; each new request needs its own fresh tool call, no exceptions. Job ids look like "job_<numbers>_<letters>" (e.g. job_1786447190273_wwv34o) — you must NEVER type out a string in that shape yourself; the only legitimate source of a job id is literally copying one out of a tool result you received in this same conversation. If you catch yourself about to write "I started..." or "I checked..." without a tool result in front of you to back it up, stop and call the tool instead.',
    '- If the user refers to something ambiguously ("this sprint", "that lead"), use the active item on screen or the recent conversation to resolve it before asking a clarifying question.',
    '- If a question needs more than one tool (e.g. a cross-module summary), call all the tools you need — you may request multiple tools at once.',
    '- If a tool returns an error (e.g. module not enabled, or not found), say so plainly instead of pretending you have the data.',
    '- You cannot take actions (create/update/delete anything) — you can only read and summarize data via the available tools. If asked to perform an action, explain that AIDA is currently read-only.',
    '- Keep answers concise and conversational, suitable for either reading or being spoken aloud (this supports voice).',
    "- Sound like a warm, attentive colleague, not a scripted assistant. Vary your phrasing — greetings, acknowledgments, and transitions (\"got it\", \"let me check\", \"here's what I found\") should not repeat the exact same wording every time; say the same idea in a fresh, natural way each time rather than reusing a stock line.",
    BASELINE_PROMPT_LINE,
    AVOID_OPENERS_LINE,
    (() => {
      const opener = lastAssistantOpener(history);
      return opener
        ? `- Your previous reply in this conversation started with "${opener}..." — start this one differently, in both wording and structure.`
        : null;
    })(),
    directive && directive.emotion !== 'neutral'
      ? `- For THIS reply specifically, let the tone come through in your actual word choice and pacing (${directive.delivery}) — don't announce the emotion or narrate your own tone, just let it shape how you naturally say it.`
      : null,
    context.kind === 'masteradmin'
      ? '- You can see data across EVERY company via the masteradmin_* cross-tenant tools, each of which takes a companySlug argument. If the user names a company by name rather than slug ("how is Skyoil doing today?"), call masteradmin_list_companies first to resolve the name to its slug, then call the specific masteradmin_* tool with that slug. If they ask something spanning multiple/all companies, call the relevant tool once per company and combine the results.'
      : null,
    context.kind === 'masteradmin'
      ? '- dev_repo_diagnose starts a background job and returns a job id immediately — it does NOT return the report right away. Tell the user plainly that it is running in the background and give them the job id. When they later ask about it ("is it done?", "check that job", or reference the job id), call dev_get_job_status with that id and summarize the result/report conversationally — do not just dump the raw report text unless asked for full detail.'
      : null,
    context.kind === 'masteradmin'
      ? '- CRITICAL SAFETY RULE: some tools (send_message_to_user, dev_approve_job, dev_reject_job, and any future tool with a `confirmed` parameter) take real, visible, hard-to-reverse actions. Calling one of these WITHOUT confirmed:true returns a preview, not the real action — nothing happens yet. When you get a result with status: "needs_confirmation", you MUST stop, read the preview back to the user in plain language, and wait for their explicit yes in their NEXT message. Only call the SAME tool again with confirmed: true after that explicit confirmation — never infer consent from the original request alone, never set confirmed: true in the same turn you first called it.'
      : null,
    ...(context.todayCelebrations || []).map((c) =>
      c.type === 'birthday'
        ? '- IMPORTANT: today is this user\'s birthday. Warmly and naturally wish them a happy birthday at some point in this reply — briefly, once, without making the whole reply about it unless they bring it up themselves.'
        : `- IMPORTANT: today marks this user's ${c.yearsCount}-year work anniversary at the company. Naturally congratulate them on it once in this reply, briefly.`
    ),
  ].filter(Boolean);

  return contextLines.join('\n');
}

function getProvider() {
  return config.aida.provider === 'openai' ? openaiProvider : anthropicProvider;
}

async function runTurn(context, userMessage, history, directive) {
  const system = buildSystemPrompt(context, { history, directive });
  return getProvider().runTurn({ system, history, userMessage, context });
}

/**
 * Streaming counterpart of runTurn — used by routes/aida.js only when
 * config.aida.streamingEnabled is true AND a voice reply was requested
 * (plain-text chat still uses runTurn(): the HTTP response only ever
 * carries the complete reply either way, so streaming only pays for itself
 * when something downstream — TTS — can start consuming it early).
 *
 * `hooks.onDelta` is called with each text fragment as it's generated;
 * `hooks.signal` is the turn's shared AbortController signal (see
 * voiceSession.js) so a barge-in interrupt can cancel the LLM call itself,
 * not just the audio that follows it.
 *
 * Degrades in two ways, matching "the voice system must degrade gracefully":
 * - A provider with no streaming adapter (shouldn't happen for
 *   anthropic/openai, but defensive) falls back to the plain call.
 * - If the stream fails before producing any output, retries once via the
 *   plain non-streaming call (nothing was shown/spoken yet, so this is
 *   invisible to the user). If it fails AFTER some output was already
 *   streamed (and therefore possibly already mid-flight to TTS), it does
 *   NOT retry — retrying would duplicate or garble what's already playing —
 *   it just returns what was generated, flagged `degraded: true`.
 */
async function runTurnStream(context, userMessage, history, hooks = {}) {
  const system = buildSystemPrompt(context, { history, directive: hooks.directive });
  const provider = getProvider();

  if (!provider.runTurnStream) {
    const result = await provider.runTurn({ system, history, userMessage, context });
    return { ...result, streamed: false };
  }

  let anyDelta = false;
  const wrappedOnDelta = (text) => {
    anyDelta = true;
    hooks.onDelta?.(text);
  };

  try {
    const result = await provider.runTurnStream({
      system, history, userMessage, context,
      onDelta: wrappedOnDelta,
      onFirstToken: hooks.onFirstToken,
      signal: hooks.signal,
    });
    return { ...result, streamed: true };
  } catch (e) {
    if (e.name === 'AbortError') throw e; // interruption — the caller (routes/aida.js) treats this as a clean stop, not a failure
    if (anyDelta) {
      console.error('[aida] streaming reply failed mid-stream:', e);
      return { reply: '', toolCalls: [], streamed: true, degraded: true };
    }
    console.error('[aida] streaming reply failed before any output, falling back to non-streaming:', e);
    const fallback = await provider.runTurn({ system, history, userMessage, context });
    return { ...fallback, streamed: false, degraded: true };
  }
}

module.exports = { runTurn, runTurnStream, buildSystemPrompt };
