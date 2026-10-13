const config = require('../config');
const { callLLM } = require('./llmCompletion');
const jobStore = require('./jobs/jobStore');
const { sendWhatsAppMessage } = require('./whatsapp');

/**
 * AIDA roadmap item 8.5 — detects when AIDA just told the master admin it
 * genuinely can't do something, and proposes a real plan to fix the gap
 * (see jobKinds/capabilityGapProposal.js) instead of the refusal just
 * disappearing into chat history. Hooked into routes/aida.js's
 * runConversationTurn, right after a turn's reply is fully resolved.
 *
 * Two-step, cost-conscious by design (same shape as emailMonitor.js's own
 * isUrgent/needsPlan classification): a cheap regex pre-filter runs on
 * EVERY masteradmin turn for free, and only a genuine-looking refusal
 * spends a real (cheap, single-shot) LLM call to confirm + extract what was
 * actually being asked for. Master-admin-only, since this proposes to
 * modify the exact backend AIDA is running from — a tenant turn never
 * reaches this at all (see the context.kind check in checkForCapabilityGap).
 */

// Deliberately generic phrasing, not tied to any specific feature — matches
// the SHAPE of a capability refusal ("I can't ...", "I don't have access to
// ...") regardless of what's actually missing.
const REFUSAL_PATTERNS = [
  /\bI can'?t\b/i,
  /\bI('m| am) not able to\b/i,
  /\bI('m| am) unable to\b/i,
  /\bI don'?t (currently )?(have|support|do)\b/i,
  /\bI don'?t have access to\b/i,
  /\bthat'?s not something I can\b/i,
  /\bno (built-in|existing) (way|capability|support) (for|to)\b/i,
];

const CONFIRM_SYSTEM_PROMPT = [
  'You review a single reply an AI assistant (AIDA) just gave inside a real business ERP app, to decide if it ' +
    'represents a genuine capability gap worth proposing to fix.',
  'A genuine capability gap: AIDA explicitly declined to do something because it lacks a tool/integration/feature ' +
    'to do it — e.g. "I can\'t send a fax", "I don\'t have access to your calendar".',
  'NOT a genuine capability gap: a clarifying question, a normal conversational reply, AIDA describing the ' +
    'CURRENT STATE of some data (e.g. "there are no late employees today"), a permission/auth error, or AIDA ' +
    'successfully doing something else instead.',
  'Respond with ONLY a single JSON object, no markdown fencing: ' +
    '{"isCapabilityGap": true|false, "whatToBuild": "a short, specific description of the missing capability, ' +
    'phrased as a feature to build — or empty string if isCapabilityGap is false"}',
].join(' ');

async function confirmCapabilityGap(userMessage, reply) {
  const userContent = `The user asked: ${userMessage}\n\nAIDA replied: ${reply}`;
  try {
    const raw = await callLLM(CONFIRM_SYSTEM_PROMPT, userContent, 300);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    return {
      isCapabilityGap: parsed.isCapabilityGap === true,
      whatToBuild: typeof parsed.whatToBuild === 'string' ? parsed.whatToBuild.trim() : '',
    };
  } catch {
    return { isCapabilityGap: false, whatToBuild: '' };
  }
}

// In-memory only (resets on restart, same tradeoff emailMonitor.js's
// emailLog dedupe doesn't even attempt) — just enough to stop one
// conversation from spamming a job per follow-up message about the same
// gap. A real duplicate-proposal across restarts is a rare, low-cost
// annoyance (an extra WhatsApp message), not worth a DB table for.
const COOLDOWN_MS = 30 * 60 * 1000;
const lastProposalAt = new Map();

function sessionKeyFor(context) {
  return context.kind === 'masteradmin' ? `masteradmin:${context.userId}` : `${context.tenantSlug}:${context.userId}`;
}

/**
 * Fire-and-forget — never throws, never delays the chat response this is
 * called after. Call with the SAME context/userMessage/result a chat turn
 * already resolved.
 */
async function detectAndProposeCapabilityGap({ context, userMessage, reply, toolCalls }) {
  try {
    if (context.kind !== 'masteradmin') return; // see file header — proposing to modify the backend is master-admin-only
    if (!reply || !reply.trim()) return;
    if (Array.isArray(toolCalls) && toolCalls.length) return; // a turn that successfully used a tool wasn't a refusal
    if (!REFUSAL_PATTERNS.some((re) => re.test(reply))) return;

    const key = sessionKeyFor(context);
    const last = lastProposalAt.get(key);
    if (last && Date.now() - last < COOLDOWN_MS) return;

    const { isCapabilityGap, whatToBuild } = await confirmCapabilityGap(userMessage, reply);
    if (!isCapabilityGap || !whatToBuild) return;

    lastProposalAt.set(key, Date.now());

    // No manual "start it now" call needed — jobRunner.js's own poll loop
    // (setInterval, see start()) picks up every 'queued' job on its normal
    // cadence, same as every other createJob() call site in this codebase.
    await jobStore.createJob({
      kind: 'capability_gap_proposal',
      companySlug: null,
      createdByUserId: context.userId,
      payload: { whatToBuild, originalUserMessage: userMessage },
    });
  } catch (e) {
    console.error('[aida] capabilityGapDetector failed (non-fatal, chat response already sent):', e.message);
  }
}

module.exports = { detectAndProposeCapabilityGap };
