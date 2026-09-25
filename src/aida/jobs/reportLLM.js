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

async function generateReport(repoName, files) {
  return callLLM(SYSTEM_PROMPT, buildUserContent(repoName, files), 4096);
}

// Used by jobKinds/userReportedIssue.js to pick which of the two authorized
// repos a tenant-submitted bug/feature report most likely belongs to, BEFORE
// spending a real sandbox+coding-agent run on it — cheap (one short
// completion, no repo cloned yet) triage, not a guarantee. A wrong guess
// isn't catastrophic: the coding agent's own PR still goes through human
// approval either way, so worst case is an unhelpful PR that gets rejected.
const CLASSIFY_SYSTEM_PROMPT = [
  'You triage bug/feature reports for a multi-tenant business ERP called OG Track, built from two repos:',
  '- BACKEND: the Node/Express API + SQL layer — business logic, calculations, data storage, third-party ' +
    'integrations (BigCommerce, Razorpay, WhatsApp), and the AIDA AI assistant\'s own logic.',
  '- FRONTEND: the browser UI — what the user visually sees, clicks, and reads on screen; forms, layout, ' +
    'buttons, how data is displayed (not where that data comes from or how it was calculated).',
  'Given a user-submitted report, decide which repo most likely needs to change to address it.',
  'Respond with ONLY a single JSON object, nothing else, no markdown fencing: ' +
    '{"repo": "frontend" | "backend", "reasoning": "one short sentence"}',
  'If the report is genuinely ambiguous or could plausibly be either, default to "frontend" — most ' +
    'user-visible complaints trace back to what they see on screen even when the deeper cause is elsewhere, ' +
    'and a human reviews whatever gets produced either way before anything merges.',
].join(' ');

async function classifyIssueRepo({ type, description }) {
  const userContent = `Report type: ${type}\n\nDescription:\n${description}`;
  let raw;
  try {
    raw = await callLLM(CLASSIFY_SYSTEM_PROMPT, userContent, 200);
  } catch (e) {
    return { repo: 'frontend', reasoning: `Classification call failed (${e.message}) — defaulted to frontend.` };
  }
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const repo = parsed.repo === 'backend' ? 'backend' : 'frontend';
    return { repo, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' };
  } catch {
    return { repo: 'frontend', reasoning: 'Classification response was not valid JSON — defaulted to frontend.' };
  }
}

// Used by jobKinds/userReportedIssue.js (stage 1 — "plan") to turn a raw
// user-submitted report into a short, human-reviewable plan BEFORE any
// sandbox or coding-agent run happens — this is what gets sent to the
// masteradmin/developer/tester/manager for approval, not the eventual code
// change itself.
const PLAN_SYSTEM_PROMPT = [
  'You write a SHORT plan of action for a bug/feature report submitted to a multi-tenant business ERP.',
  'You are NOT writing code and have NOT seen the actual source — this is a plan for a human to review ' +
    'BEFORE any code is touched, not a diagnosis of the real cause.',
  'Respond with ONLY a single JSON object, no markdown fencing: ' +
    '{"summary": "one or two plain sentences restating what was reported, in your own words", ' +
    '"actionItems": ["short imperative step", "..."]}',
  '2 to 5 actionItems, each a short imperative phrase (e.g. "Locate the order-total calculation in the ' +
    'checkout flow", "Reproduce the mismatch with a real order", "Add a fix and a regression test"). ' +
    'Keep every item generic enough to be true without having read the code yet — do not invent specific ' +
    'file names or claim a root cause you have no evidence for.',
].join(' ');

async function generatePlanOfAction({ type, description, repo }) {
  const userContent = `Report type: ${type}\nLikely area: ${repo}\n\nDescription:\n${description}`;
  const fallback = {
    summary: description.trim().slice(0, 200),
    actionItems: ['Investigate the report and confirm whether it reproduces.', 'Implement a fix or the requested feature if confirmed.'],
  };
  let raw;
  try {
    raw = await callLLM(PLAN_SYSTEM_PROMPT, userContent, 500);
  } catch (e) {
    return { ...fallback, note: `Plan generation call failed (${e.message}) — used a generic fallback plan.` };
  }
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary;
    const actionItems = Array.isArray(parsed.actionItems) && parsed.actionItems.length
      ? parsed.actionItems.filter((i) => typeof i === 'string' && i.trim())
      : fallback.actionItems;
    return { summary, actionItems };
  } catch {
    return { ...fallback, note: 'Plan generation response was not valid JSON — used a generic fallback plan.' };
  }
}

module.exports = { generateReport, classifyIssueRepo, generatePlanOfAction };
