const OpenAI = require('openai');
const config = require('../../../config');
const tools = require('../tools');

let client = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.aida.codingAgent.apiKey });
  return client;
}

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file\'s full contents, given a path relative to the sandbox root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Overwrite (or create) a file with new content, given a path relative to the sandbox root. Always write the COMPLETE new file content, not a diff/patch.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files/directories under a path relative to the sandbox root (node_modules and .git are always excluded).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Defaults to the sandbox root (".") if omitted.' }, recursive: { type: 'boolean' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one command (e.g. npm) with the given arguments, with its working directory locked to the sandbox root. Not a shell — no pipes/redirects/chaining.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e.g. "npm"' },
          args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["test"] or ["install"]' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call this exactly once, when you are completely done (whether you succeeded, partially succeeded, or could not fix the issue). Ends the session.',
      parameters: {
        type: 'object',
        properties: {
          success: { type: 'boolean', description: 'Whether the task was actually accomplished and verified (e.g. tests pass).' },
          summary: { type: 'string', description: 'Plain-language explanation of what you found and what you did (or why you could not fix it). This is shown to a human reviewer.' },
        },
        required: ['success', 'summary'],
      },
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

/**
 * Runs the agent loop against one sandboxed directory for one task
 * description. Returns { success, summary, toolLog } where toolLog is the
 * full sequence of tool calls made (for the job's audit trail / PR
 * description), regardless of outcome.
 */
async function runCodingAgent({ sandboxDir, task, maxIterations = 25, onEvent }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  const toolLog = [];
  const emit = (event) => { try { onEvent?.(event); } catch { /* best-effort only */ } };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await getClient().chat.completions.create({
      model: config.aida.codingAgent.model,
      messages,
      tools: TOOL_SCHEMAS,
    });
    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls || !message.tool_calls.length) {
      // The agent replied with plain text instead of calling a tool (including finish)
      // — nudge it back toward the required protocol rather than silently ending.
      messages.push({ role: 'user', content: 'Please continue by calling a tool, or call finish if you are done.' });
      continue;
    }

    for (const call of message.tool_calls) {
      let args = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      if (call.function.name === 'finish') {
        emit({ type: 'finish', ...args });
        return { success: !!args.success, summary: args.summary || '(no summary provided)', toolLog };
      }

      const result = executeTool(sandboxDir, call.function.name, args);
      const resolved = result instanceof Promise ? await result : result;
      toolLog.push({ tool: call.function.name, args: redactForLog(call.function.name, args), result: summarizeForLog(resolved) });
      emit({ type: 'tool', tool: call.function.name, args });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resolved).slice(0, 30_000) });
    }
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

// write_file's `content` can be large and isn't useful in an audit log at
// full length — keep the log readable without losing the other args.
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
