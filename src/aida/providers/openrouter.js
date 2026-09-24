const config = require('../../config');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

module.exports = createOpenAICompatibleProvider({
  getApiKey: () => config.aida.openrouterApiKey,
  getBaseURL: () => 'https://openrouter.ai/api/v1',
  // OpenRouter asks callers to identify themselves via these two optional
  // headers (used for their own leaderboards/rankings, not required for the
  // API to function) — see openrouter.ai/docs.
  defaultHeaders: {
    'HTTP-Referer': 'https://ogplus.in',
    'X-Title': 'OG Track AIDA',
  },
});
