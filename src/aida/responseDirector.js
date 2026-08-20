const { isValidEmotion, emotionProfile, DEFAULT_EMOTION } = require('./personality');

/**
 * AIDA response director — decides HOW a reply should be delivered (emotion,
 * energy, pacing, whether a filler fits) as a cheap, deterministic pass over
 * the user's message and AIDA's own reply text. Deliberately NOT a second LLM
 * call: latency matters more here than nuance, and these signals (keywords,
 * punctuation, length) cover the common cases well enough on their own — see
 * docs/AIDA_VOICE_UPGRADE.md for why this was chosen over structured-output
 * from the main call or a dedicated classifier model.
 *
 * Output shape ("SpeechDirective"):
 *   { emotion, delivery, energy, pacing, fillerCategory }
 */

const RULES = [
  // [emotion, fillerCategory, regex tested against the user's message]
  ['frustrated', 'empathy', /\b(not working|broken|doesn'?t work|still (failing|broken)|ugh|annoying|frustrat|angry|why (isn'?t|won'?t|can'?t))\b/i],
  ['amused', 'amusement', /\b(haha+|lol+|lmao|hilarious|that'?s funny|joke)\b/i],
  ['surprised', 'surprise', /\b(wow|whoa|really\?|no way|seriously\?|can'?t believe)\b/i],
  ['warm', 'acknowledgement', /\b(thanks|thank you|awesome|great job|nailed it|worked!|fixed it|it works|appreciate)\b/i],
  ['serious', 'thinking', /\b(urgent|critical|compliance|legal|security breach|incident|production (down|outage)|data loss)\b/i],
  ['curious', 'acknowledgement', /\b(what do you think|any idea why|curious|wonder(ing)? (if|why|how))\b/i],
  ['thoughtful', 'thinking', /\b(why (does|is|do)|explain|how (does|do)|walk me through|what'?s the (difference|reason))\b/i],
];

const TECHNICAL_RE = /\b(error|bug|exception|stack trace|api|endpoint|query|database|deploy|config|schema|null|undefined|null pointer|function|module|import|build fail)\b/i;

function classifyFromMessage(userMessage) {
  const text = userMessage || '';
  for (const [emotion, fillerCategory, re] of RULES) {
    if (re.test(text)) return { emotion, fillerCategory };
  }
  if (TECHNICAL_RE.test(text)) return { emotion: 'thoughtful', fillerCategory: 'thinking' };
  return { emotion: DEFAULT_EMOTION, fillerCategory: 'thinking' };
}

function pacingFor(emotion, replyLength) {
  if (emotion === 'empathetic' || emotion === 'frustrated' || emotion === 'serious' || emotion === 'thoughtful') return 'slow';
  if (replyLength > 0 && replyLength < 80) return 'quick';
  return 'moderate';
}

/**
 * Builds the directive for one turn. `userMessage` drives the classification
 * (it's known before the LLM call even starts, which is what lets a filler
 * be selected immediately rather than waiting on the reply). `replyText` is
 * optional and only refines pacing/energy once available.
 */
function buildDirective(userMessage, replyText) {
  const { emotion: rawEmotion, fillerCategory } = classifyFromMessage(userMessage);
  const emotion = isValidEmotion(rawEmotion) ? rawEmotion : DEFAULT_EMOTION;
  const profile = emotionProfile(emotion);
  const pacing = pacingFor(emotion, (replyText || '').length);

  return {
    emotion,
    delivery: profile.description,
    energy: profile.energy,
    pacing,
    fillerCategory,
  };
}

/** Defensive fallback used anywhere a directive might be malformed/missing — never let a bad directive break playback. */
function safeDirective(directive) {
  if (!directive || !isValidEmotion(directive.emotion)) {
    const profile = emotionProfile(DEFAULT_EMOTION);
    return { emotion: DEFAULT_EMOTION, delivery: profile.description, energy: profile.energy, pacing: 'moderate', fillerCategory: 'thinking' };
  }
  return directive;
}

module.exports = { buildDirective, safeDirective, classifyFromMessage };
