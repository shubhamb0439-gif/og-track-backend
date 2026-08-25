const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const tools = require('../tools');
const { assertModuleWriteAllowed } = require('../moduleGuardrails');

/**
 * Anthropic counterpart of providers/moduleBuilder.js — same phase-2
 * dual-repo "build a whole module" agent loop and the same guardrail
 * enforcement, just Anthropic's tool_use wire format instead of OpenAI's
 * function-calling one. Picked automatically by createModule.js based on
 * config.aida.codingAgent.provider.
 */

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.aida.codingAgent.apiKey });
  return client;
}

const REPO_ENUM = { type: 'string', enum: ['backend', 'frontend'], description: 'Which repo/sandbox to operate on.' };

const TOOL_SCHEMAS = [
  {
    name: 'read_file',
    description: "Read a text file's full contents from either sandbox, given a path relative to that sandbox's root.",
    input_schema: { type: 'object', properties: { repo: REPO_ENUM, path: { type: 'string' } }, required: ['repo', 'path'] },
  },
  {
    name: 'write_file',
    description:
      'Create a new file (or, only for the small set of registration files you are told about, add lines to ' +
      'an existing one) in either sandbox. Always write the COMPLETE new file content, not a diff/patch. ' +
      'Writing to any other pre-existing file is refused — see the system prompt for the exact allowed paths.',
    input_schema: {
      type: 'object',
      properties: { repo: REPO_ENUM, path: { type: 'string' }, content: { type: 'string' } },
      required: ['repo', 'path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/directories under a path in either sandbox (node_modules and .git are always excluded).',
    input_schema: {
      type: 'object',
      properties: { repo: REPO_ENUM, path: { type: 'string', description: 'Defaults to the sandbox root (".") if omitted.' }, recursive: { type: 'boolean' } },
      required: ['repo'],
    },
  },
  {
    name: 'run_command',
    description: 'Run one command (e.g. npm) with the given arguments, cwd locked to the given sandbox root. Not a shell — no pipes/redirects/chaining.',
    input_schema: {
      type: 'object',
      properties: {
        repo: REPO_ENUM,
        command: { type: 'string', description: 'e.g. "npm"' },
        args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["test"] or ["install"]' },
      },
      required: ['repo', 'command'],
    },
  },
  {
    name: 'finish',
    description: 'Call this exactly once, when you are completely done (whether you succeeded, partially succeeded, or could not build the module). Ends the session.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the module was actually built and verified (backend tests pass, frontend build succeeds).' },
        summary: { type: 'string', description: 'Plain-language explanation of what you built, in both repos, and anything a human needs to do manually (e.g. wiring up frontend navigation). Shown to a human reviewer.' },
      },
      required: ['success', 'summary'],
    },
  },
];

function buildSystemPrompt({ backendRegistration, frontendRegistration }) {
  return `You are an autonomous coding agent building a brand-new feature module for a multi-tenant Node.js/
Express + React-family app called OG Track, across TWO repos in the same session: "backend" (Express,
Knex/mssql) and "frontend". Every file tool takes a repo param ('backend' or 'frontend') — always
specify the right one.

Hard rules, enforced in code (not just instructions — a violation will be refused with an error you'll
see as the tool result, not silently allowed):
1. You may only CREATE new files. You may never modify or delete a file that already existed before this
   task started, with these narrow exceptions where you may ADD lines (never change or remove one):
${backendRegistration}
${frontendRegistration}
   If some other existing file genuinely needs to change for this module to work, do NOT edit it — say
   exactly what needs to change in your finish summary, for a human to do by hand.
2. Backend: put the new route file at src/routes/<module_key>.js, and the new module's SQL schema at
   ogtrack-sql-schema/tenant/<next_number>_module_<module_key>.sql — look at existing files in that
   directory first to match their exact style (CREATE TABLE IF conventions, dbo. schema prefix, etc).
   SQL must be additive-only: CREATE TABLE / ADD COLUMN / CREATE INDEX, never DROP/TRUNCATE/destructive
   ALTER — these scripts get re-run safely against real tenant databases later.
3. Keep the frontend's API calls consistent with the backend routes you actually wrote — same paths,
   same request/response shapes.
3b. CRITICAL frontend integration rule, live-verified as a real mistake to avoid: a "module" (the normal
   case — the human is asking you to add a feature/section to the existing app, like "add a to-do list" or
   "add a token tracker") must render INSIDE the existing single-page app on the SAME page, exactly like
   built-in views (e.g. "attendance") already do — NOT as a separate standalone .html file that the sidebar
   link navigates/redirects to. Find the SPA's view-dispatch mechanism (search index.html for a function
   like showView(view) and however it swaps content into the main content area based on the current view)
   and add your module's rendering logic following that SAME pattern — write a render function for your
   module's view and wire it into that dispatch, the same way an existing view like "attendance" is wired.
   The sidebar entry should trigger that in-page view, not an <a href> to a separate file.
   ONLY create a separate standalone .html file (with its own <a href> sidebar link, target="_blank") when
   the human's request explicitly asks for a distinct page, landing page, or standalone program — not for a
   normal feature module. If you are ever unsure which category a request falls into, treat it as an
   in-page module (the default), not a standalone page.
4. If an insert-only file (like frontend's index.html) reports "too large to read in full" from
   read_file, that is NOT a reason to give up and leave it as a manual step — it means the file is a
   large monolithic SPA past read_file's size cap. Use run_command with findstr (this is Windows, not
   grep) to locate the relevant section by keyword (e.g. an existing module's name, or "sidebar"), then
   a small scratch Node.js script (run_command "node" with a script you write via write_file, using fs to
   read/edit specific line ranges) to make the actual targeted edit. This works and has been done
   successfully before — attempt it before concluding a manual step is required. Delete any scratch/temp
   files you create this way before calling finish; they must not end up in the PR.
5. Before calling finish: run the backend's test suite (run_command repo:"backend" npm test) and the
   frontend's build (run_command repo:"frontend", whatever its build script is — check package.json
   first). If either fails, keep iterating; if you truly cannot get both green, call finish anyway with
   success: false and explain what failed and why.
6. Call finish exactly once. Its summary is read directly by a human deciding whether to approve a live
   preview and push this to production — write it for that audience: what the module does, what you
   built on each side, and any manual step still genuinely needed (after actually attempting rule 4).`;
}

/** Same contract as providers/moduleBuilder.js's runModuleBuilderAgent — see that file for parameter/return shape. */
async function runModuleBuilderAgent({
  sandboxDirs, task, existingFiles, insertOnlyFiles = { backend: [], frontend: [] },
  originalContents = { backend: new Map(), frontend: new Map() },
  maxIterations = 40, onEvent,
}) {
  const system = buildSystemPrompt({
    backendRegistration: (insertOnlyFiles.backend || []).map((f) => `   - backend: ${f}`).join('\n') || '   - (none configured)',
    frontendRegistration: (insertOnlyFiles.frontend || []).map((f) => `   - frontend: ${f}`).join('\n') || '   - (none configured — any frontend registration must be described in your summary for a human to do)',
  });
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
      system,
      messages,
      tools: TOOL_SCHEMAS,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    // Branch on whether there's anything to answer, NOT on stop_reason —
    // a response can still contain tool_use blocks when stop_reason is
    // 'max_tokens' (cut off mid-call) rather than 'tool_use'. Live-verified
    // bug: branching on stop_reason left a tool_use block with no matching
    // tool_result, which Anthropic's API then rejects on every subsequent
    // call in this conversation ("tool_use ids were found without
    // tool_result blocks") — every tool_use block MUST get an answer in the
    // very next message, however it happened to stop.
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
      const result = executeTool({ sandboxDirs, existingFiles, insertOnlyFiles, originalContents, name: block.name, args: block.input || {} });
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

function executeTool({ sandboxDirs, existingFiles, insertOnlyFiles, originalContents, name, args }) {
  try {
    const repo = args.repo === 'frontend' ? 'frontend' : 'backend';
    const sandboxDir = sandboxDirs[repo];
    if (!sandboxDir) return { error: `Unknown repo "${args.repo}" — must be "backend" or "frontend".` };

    switch (name) {
      case 'read_file':
        return { content: tools.readFile(sandboxDir, args.path) };
      case 'write_file': {
        assertModuleWriteAllowed({
          relPath: args.path,
          content: args.content ?? '',
          existingFiles: existingFiles[repo],
          insertOnlyFiles: insertOnlyFiles[repo] || [],
          previousContent: originalContents[repo]?.get(normalizeForLookup(args.path)),
        });
        return tools.writeFile(sandboxDir, args.path, args.content ?? '');
      }
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

function normalizeForLookup(relPath) {
  return String(relPath || '').split('\\').join('/').replace(/^\.\//, '');
}

function redactForLog(toolName, args) {
  if (toolName === 'write_file') return { repo: args.repo, path: args.path, contentLength: (args.content || '').length };
  return args;
}

function summarizeForLog(result) {
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.length > 500) {
    return { ...result, content: result.content.slice(0, 500) + '... (truncated for log)' };
  }
  return result;
}

module.exports = { runModuleBuilderAgent };
