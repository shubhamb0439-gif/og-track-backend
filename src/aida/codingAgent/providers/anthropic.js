const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const tools = require('../tools');

/**
 * Anthropic counterpart of providers/openai.js — same phase-1 "fix a bug in
 * one sandbox" agent loop, same tool set/rules/return shape, just Anthropic's
 * tool_use wire format instead of OpenAI's function-calling one (see
 * src/aida/providers/anthropic.js for the same translation on AIDA's normal
 * chat loop). Picked automatically by devFix.js based on
 * config.aida.codingAgent.provider — switching providers is an env var
 * change (AIDA_CODING_AGENT_PROVIDER=anthropic + ANTHROPIC_API_KEY), no code
 * change, exactly as planned back when this was OpenAI-only.
 */

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.aida.codingAgent.apiKey });
  return client;
}

const TOOL_SCHEMAS = [
  {
    name: 'read_file',
    description: 'Read a text file\'s full contents, given a path relative to the sandbox root.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Overwrite (or create) a file with new content, given a path relative to the sandbox root. Always write the COMPLETE new file content, not a diff/patch.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'list_files',
    description: 'List files/directories under a path relative to the sandbox root (node_modules and .git are always excluded).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Defaults to the sandbox root (".") if omitted.' }, recursive: { type: 'boolean' } },
    },
  },
  {
    name: 'run_command',
    description: 'Run one command (e.g. npm) with the given arguments, with its working directory locked to the sandbox root. Not a shell — no pipes/redirects/chaining.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'e.g. "npm"' },
        args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["test"] or ["install"]' },
      },
      required: ['command'],
    },
  },
  {
    name: 'finish',
    description: 'Call this exactly once, when you are completely done (whether you succeeded, partially succeeded, or could not fix the issue). Ends the session.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the task was actually accomplished and verified (e.g. tests pass).' },
        summary: { type: 'string', description: 'Plain-language explanation of what you found and what you did (or why you could not fix it). This is shown to a human reviewer.' },
      },
      required: ['success', 'summary'],
    },
  },
];

const SYSTEM_PROMPT = `You are an autonomous coding agent working inside a disposable, isolated sandbox — a
fresh git clone of a real Node.js/Express codebase (uses Knex for SQL). You have file
read/write/list tools and a run_command tool (no shell — one program + args at a time).

Rules, in order of importance:
1. Never modify anything under the "test/" directory to make a failing test pass —
   if you believe a test itself is wrong, say so in your final summary instead of
   editing it. Your job is to fix the SOURCE, not the test.
2. Keep changes minimal and focused on the specific task you were given. Do not
   refactor, rename, or "clean up" unrelated code even if you notice something else
   you'd improve — note it in your summary instead.
3. If read_file reports a file is "too large to read in full", that is NOT a reason to give up on
   editing it — some legitimate files in this codebase exceed that limit. Use run_command with findstr
   (Windows — not grep) to locate the relevant section by keyword, then a small scratch Node.js script
   (run_command "node" with a script you write via write_file, using fs to read/edit specific line
   ranges) to make the actual targeted edit. This has worked before. Delete any scratch/temp files you
   create this way before calling finish; they must not end up in the PR/diff.
4. Before calling finish, run the test suite (run_command: npm test) and confirm the
   relevant tests pass. If this repo has no package.json/test command at all, say so in your summary
   instead of trying to run one. If you cannot get tests to pass, call finish anyway with
   success: false and explain what you tried and why it didn't work — do not loop
   forever, and do not claim success without actually having run the tests.
5. Call finish exactly once, when you are completely done. Its summary is shown
   directly to a human reviewer deciding whether to merge your change — write it for
   that audience: what was wrong, why, and what you changed.`;

/** Same contract as providers/openai.js's runCodingAgent — see that file for the return shape. */
async function runCodingAgent({ sandboxDir, task, maxIterations = 25, onEvent }) {
  const messages = [{ role: 'user', content: task }];
  const toolLog = [];
  const emit = (event) => { try { onEvent?.(event); } catch { /* best-effort only */ } };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await getClient().messages.create({
      model: config.aida.codingAgent.model,
      // A write_file call has to fit an entire file's contents in THIS same
      // response — 4096 was cutting off larger files mid-argument, which is
      // its own problem (see below) but also, critically, must never be the
      // reason we skip answering a tool_use block.
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOL_SCHEMAS,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    // Branch on whether there's anything to answer, NOT on stop_reason —
    // a response can still contain tool_use blocks when stop_reason is
    // 'max_tokens' (cut off mid-call) rather than 'tool_use'. Live-verified
    // bug (in the sibling moduleBuilder loop, same pattern here): branching
    // on stop_reason left a tool_use block with no matching tool_result,
    // which Anthropic's API then rejects on every subsequent call in this
    // conversation — every tool_use block MUST get an answer in the very
    // next message, however the response happened to stop.
    if (!toolUseBlocks.length) {
      messages.push({ role: 'user', content: 'Please continue by calling a tool, or call finish if you are done.' });
      continue;
    }

    const finishBlock = toolUseBlocks.find((b) => b.name === 'finish');
    if (finishBlock) {
      emit({ type: 'finish', ...finishBlock.input });
      return { success: !!finishBlock.input.success, summary: finishBlock.input.summary || '(no summary provided)', toolLog };
    }

    const results = [];
    for (const block of toolUseBlocks) {
      const result = executeTool(sandboxDir, block.name, block.input || {});
      const resolved = result instanceof Promise ? await result : result;
      toolLog.push({ tool: block.name, args: redactForLog(block.name, block.input), result: summarizeForLog(resolved) });
      emit({ type: 'tool', tool: block.name, args: block.input });
      results.push({ block, result: resolved });
    }

    messages.push({
      role: 'user',
      content: results.map(({ block, result }) => ({
        type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result).slice(0, 30_000),
      })),
    });
  }

  return { success: false, summary: `Stopped after ${maxIterations} iterations without calling finish — likely stuck in a loop.`, toolLog };
}

function executeTool(sandboxDir, name, args) {
  try {
    switch (name) {
      case 'read_file':
        return { content: tools.readFile(sandboxDir, args.path) };
      case 'write_file':
        return tools.writeFile(sandboxDir, args.path, args.content ?? '');
      case 'list_files':
        return { files: tools.listFiles(sandboxDir, args.path || '.', { recursive: !!args.recursive }) };
      case 'run_command':
        return tools.runCommand(sandboxDir, args.command, args.args || []);
      default:
        return { error: `Unknown tool "${name}".` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

function redactForLog(toolName, args) {
  if (toolName === 'write_file') return { path: args.path, contentLength: (args.content || '').length };
  return args;
}

function summarizeForLog(result) {
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.length > 500) {
    return { ...result, content: result.content.slice(0, 500) + '... (truncated for log)' };
  }
  return result;
}

module.exports = { runCodingAgent };
