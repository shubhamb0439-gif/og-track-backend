const config = require('../../config');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

module.exports = createOpenAICompatibleProvider({
  getApiKey: () => config.aida.groqApiKey,
  getBaseURL: () => 'https://api.groq.com/openai/v1',
});
