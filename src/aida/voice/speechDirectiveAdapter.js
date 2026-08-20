/**
 * Converts a SpeechDirective (src/aida/responseDirector.js) into whatever the
 * ACTIVE ElevenLabs model can actually do. This is the one seam that knows
 * about the realtime-vs-expressive model split:
 *
 * - realtime models (eleven_flash_v2_5, eleven_turbo_v2_5, ...): no [tag]
 *   support — expression comes only from voice_settings (stability/style)
 *   and pacing (speed).
 * - v3-class models: DO support bracket audio tags ([laughs], [sighs], ...)
 *   for richer expression, at the cost of realtime latency guarantees.
 *
 * Switching ELEVENLABS_MODEL_ID to a v3 model turns tag support on with no
 * other code change — nothing upstream (voiceSession.js, engine.js) needs to
 * know which mode is active.
 */

const EMOTION_TAGS = {
  amused: '[laughs]',
  surprised: '[gasps]',
  empathetic: '[sighs]',
  thoughtful: '[pauses]',
};

function isExpressiveTagModel(modelId) {
  return /v3/i.test(modelId || '');
}

function voiceSettingsFor(directive, baseSpeed) {
  const energy = Math.max(0, Math.min(1, directive.energy ?? 0.45));
  // Lower stability = more varied/expressive delivery; higher = flatter and more consistent.
  // Keep both within a conservative band — the goal is subtle variation, not a different voice.
  const stability = Math.max(0.3, Math.min(0.75, 0.72 - energy * 0.3));
  const style = Math.max(0, Math.min(0.45, energy * 0.4));
  const speed = adjustSpeedForPacing(baseSpeed, directive.pacing);
  return { stability, style, speed };
}

function adjustSpeedForPacing(baseSpeed, pacing) {
  if (pacing === 'slow') return Math.max(0.7, baseSpeed - 0.07);
  if (pacing === 'quick') return Math.min(1.15, baseSpeed + 0.05);
  return baseSpeed;
}

/**
 * Returns { voiceSettings, prefixText } — prefixText is a bracket tag to
 * prepend to the FIRST spoken chunk of a turn (only ever non-empty when the
 * active model supports it); voiceSettings applies to every chunk.
 */
function adaptDirective(directive, { modelId, baseSpeed }) {
  const supportsTags = isExpressiveTagModel(modelId);
  const tag = supportsTags ? EMOTION_TAGS[directive.emotion] : null;
  return {
    voiceSettings: voiceSettingsFor(directive, baseSpeed),
    prefixText: tag ? `${tag} ` : '',
    supportsExpressiveTags: supportsTags,
  };
}

module.exports = { adaptDirective, isExpressiveTagModel };
