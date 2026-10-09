const config = require('../config');

/**
 * A plain single-shot completion call — deliberately NOT the tool-use loop
 * in src/aida/providers/*.js. For callers that just need "here's some text,
 * do something with it" with no tools and nothing conversational — talks to
 * whichever provider is configured directly rather than going through
 * engine.js. Extracted from jobs/reportLLM.js once a second caller
 * (emailMonitor.js, AIDA roadmap item 3) needed the identical pattern.
 */
async function callLLM(systemPrompt, userContent, maxTokens = 4096) {
  return callLLMChat(systemPrompt, [{ role: 'user', content: userContent }], maxTokens);
}

/**
 * Same plain, tool-free completion as callLLM, but for a real back-and-forth
 * conversation — takes the full message history (alternating user/assistant
 * turns) instead of a single userContent string. Extracted once a second
 * real caller (contactChat.js, AIDA roadmap item 9's inbound WhatsApp
 * recognition) needed multi-turn history with the SAME "no tools, just an
 * LLM call" guarantee callLLM already gives — deliberately still nowhere
 * near engine.js's tool-use loop, since that guarantee is the whole point
 * for a chat with an external, untrusted contact.
 */
async function callLLMChat(systemPrompt, messages, maxTokens = 4096) {
  if (config.aida.provider === 'openai') {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.aida.apiKey });
    const res = await client.chat.completions.create({
      model: config.aida.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
    return res.choices[0].message.content;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.aida.apiKey });
  const res = await client.messages.create({
    model: config.aida.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { callLLM, callLLMChat };
