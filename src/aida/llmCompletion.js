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
  if (config.aida.provider === 'openai') {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.aida.apiKey });
    const res = await client.chat.completions.create({
      model: config.aida.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });
    return res.choices[0].message.content;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.aida.apiKey });
  const res = await client.messages.create({
    model: config.aida.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { callLLM };
