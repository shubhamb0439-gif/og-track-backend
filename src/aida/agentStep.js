const { callLLM } = require('./llmCompletion');

/**
 * The decision half of AIDA's autonomous multi-step app control (the
 * "find a traditional dress on Flipkart and add it to cart" capability) —
 * ONE action per call, given the CURRENT screen's interactive elements and
 * what's happened so far. The Android side (AidaAccessibilityService) owns
 * the loop itself: describe screen → call this → execute the one action
 * it returns → re-describe → repeat. Deliberately NOT a tool inside the
 * normal AIDA chat engine — this is a separate, narrower decision loop with
 * its own hard safety rule, not a general-purpose capability AIDA can reach
 * for mid-conversation.
 *
 * HARD SAFETY RULE, enforced TWICE independently (never trust the LLM
 * alone for this): AIDA must never tap/confirm anything on what looks like
 * a payment, checkout, or card/OTP-entry screen. It always responds
 * "blocked" there instead, handing control back to the human. This is
 * checked (1) against the WHOLE screen's elements before the LLM is even
 * called, and (2) against the model's own chosen target element afterward
 * — so a model choosing to tap something payment-shaped doesn't just get
 * trusted because it "forgot" to flag the screen itself.
 */

const PAYMENT_PATTERNS = [
  /\bpay\s*now\b/i, /\bplace\s*order\b/i, /\bconfirm\s*(payment|order)\b/i,
  /\bproceed\s*to\s*pay\b/i, /\breview\s*order\b/i, /\bupi\s*pin\b/i,
  /\bcvv\b/i, /\bcard\s*number\b/i, /\bexpiry\s*date\b/i, /\botp\b/i,
  /\bone[- ]time\s*password\b/i, /\bnet\s*banking\b/i, /\bwallet\s*pin\b/i,
  /\bdebit\s*card\b/i, /\bcredit\s*card\b/i, /\bbuy\s*now\b/i,
];

function labelLooksLikePayment(label) {
  return !!label && PAYMENT_PATTERNS.some((re) => re.test(label));
}

function screenLooksLikePaymentPage(elements) {
  return (elements || []).some((el) => labelLooksLikePayment(el.label));
}

const AGENT_SYSTEM_PROMPT = [
  'You control an Android phone screen on the user\'s behalf, ONE action at a time, to carry out a task they described.',
  'You are given the task, the interactive elements currently visible (numbered, with a kind — button/field/text — and label), and a history of actions already taken this run.',
  'Respond with ONLY a single JSON object, no markdown fencing: ' +
    '{"action": "tap" | "type" | "scroll" | "done" | "blocked" | "ask_user", ' +
    '"elementIndex": number or null, "text": string or null, "reasoning": "one short sentence", "message": string or null}',
  '"tap": elementIndex is required (the element to tap), text must be null.',
  '"type": elementIndex is the field to type into, text is exactly what to type.',
  '"scroll": no elementIndex/text needed — reveals more of the current screen.',
  '"done": the task is genuinely complete — message explains what was accomplished, in plain language for the user.',
  '"ask_user": you are stuck, the task is ambiguous, or you need a human decision to continue — message asks one specific question.',
  '"blocked": the screen looks like a payment, checkout, card-entry, or OTP screen. NEVER choose "tap" on a screen like this — respond "blocked" instead, every time, with no exception, and let the human complete it themselves.',
  'Never choose "tap" on an element whose label is a final purchase/payment action (e.g. "Pay", "Place Order", "Confirm Payment", "Buy Now" at a checkout step, entering card/UPI/OTP details) — treat that as "blocked" instead, even if you are not asked to stop.',
  'If the same screen keeps reappearing after your last action, or you have made no real progress in several steps, respond "ask_user" instead of repeating the same action again.',
  'Keep "reasoning" to one short internal sentence — it is not shown to the user. "message" (for done/ask_user/blocked) IS shown to the user, so write it for them, plainly.',
].join(' ');

function buildScreenDescription(elements) {
  return (elements || [])
    .map((el) => {
      const flags = [el.clickable ? 'tappable' : null, el.editable ? 'editable' : null].filter(Boolean).join(', ');
      return `[${el.index}] ${el.kind}${flags ? ` (${flags})` : ''}: "${el.label}"`;
    })
    .join('\n');
}

function buildHistoryText(history) {
  if (!history || !history.length) return 'No steps taken yet this run.';
  return history
    .map((h, i) => {
      const parts = [`${i + 1}. ${h.action}`];
      if (h.elementIndex !== undefined && h.elementIndex !== null) parts.push(`on element [${h.elementIndex}]`);
      if (h.text) parts.push(`→ typed "${h.text}"`);
      return parts.join(' ');
    })
    .join('\n');
}

/**
 * Decides ONE next action. `elements` is the CURRENT screen's interactive
 * elements (same shape the Android side sends in). Returns the parsed
 * decision object, with the server's own safety override already applied
 * if the model's chosen target element looked payment-shaped.
 */
async function decideAgentStep({ task, elements }, history) {
  if (screenLooksLikePaymentPage(elements)) {
    return {
      action: 'blocked',
      reasoning: 'Screen contains payment/checkout-looking elements — blocked before asking the model at all.',
      message: "This looks like a payment or checkout step — I'll stop here so you can complete it yourself.",
    };
  }

  const userContent = `Task: ${task}\n\n${buildHistoryText(history)}\n\nCurrent screen elements:\n${buildScreenDescription(elements)}`;
  const fallback = {
    action: 'ask_user',
    reasoning: 'Decision call failed or returned unusable output.',
    message: "I ran into a problem deciding what to do next — could you tell me what you'd like me to try?",
  };

  let raw;
  try {
    raw = await callLLM(AGENT_SYSTEM_PROMPT, userContent, 400);
  } catch (e) {
    return { ...fallback, message: `I couldn't reach the decision engine (${e.message}) — want me to try again?` };
  }

  let decision;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    decision = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return fallback;
  }

  const validActions = ['tap', 'type', 'scroll', 'done', 'blocked', 'ask_user'];
  if (!validActions.includes(decision.action)) return fallback;

  // Defense in depth — re-check the ACTUAL target element's label, not
  // just whatever the model's own "reasoning" sentence claims.
  if (decision.action === 'tap' && typeof decision.elementIndex === 'number') {
    const target = (elements || []).find((el) => el.index === decision.elementIndex);
    if (target && labelLooksLikePayment(target.label)) {
      return {
        action: 'blocked',
        reasoning: 'Model chose a payment/checkout-looking target element — overridden server-side.',
        message: "That looks like a payment step — I'll stop here so you can complete it yourself.",
      };
    }
  }

  return decision;
}

module.exports = { decideAgentStep, screenLooksLikePaymentPage, labelLooksLikePayment };
