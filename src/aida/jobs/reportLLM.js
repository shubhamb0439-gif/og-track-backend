const config = require('../../config');

/**
 * A plain single-shot completion call — deliberately NOT the tool-use loop
 * in src/aida/providers/*.js. Diagnosis just needs "here's a pile of source
 * text, write a report"; it has no tools to call and nothing conversational
 * about it, so it talks to whichever provider is configured directly rather
 * than going through engine.js.
 */
const SYSTEM_PROMPT = [
  'You are a senior software engineer performing a code review and diagnosis.',
  'You are given a partial snapshot of a repository source tree (possibly truncated or ' +
    'incomplete due to size limits — say so if that visibly affects your confidence).',
  'Produce a clear, structured diagnosis report covering, wherever the evidence supports it: ' +
    'bugs, security vulnerabilities, performance issues, code quality issues, configuration ' +
    'issues, architectural concerns, and dependency/supply-chain risks.',
  'Cite specific file paths (and line context where reasonably possible) for every finding. ' +
    'If a category has no real evidence in what you were given, say so briefly rather than ' +
    'speculating or padding the report.',
  'This is diagnosis only — do not propose a patch or claim you changed anything.',
].join(' ');

function buildUserContent(repoName, files) {
  const fileBlock = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  return `Repository: ${repoName}\n\n${fileBlock || '(no readable source files found within the size budget)'}`;
}

async function generateReport(repoName, files) {
  const userContent = buildUserContent(repoName, files);

  if (config.aida.provider === 'openai') {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.aida.apiKey });
    const res = await client.chat.completions.create({
      model: config.aida.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    return res.choices[0].message.content;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.aida.apiKey });
  const res = await client.messages.create({
    model: config.aida.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { generateReport };
