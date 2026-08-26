const OpenAI = require('openai');
const config = require('../../../config');
const tools = require('../tools');
const { assertModuleWriteAllowed } = require('../moduleGuardrails');

/**
 * Phase 2 of the AIDA power-tier plan — "AIDA, create me a module." Unlike
 * providers/openai.js's runCodingAgent (phase 1: one sandbox, fixes an
 * existing bug), this agent works across TWO sandboxes at once (a backend
 * repo clone and a frontend repo clone) in a single tool-calling session, so
 * it can keep both sides consistent (the frontend's API calls actually match
 * the routes it just wrote). Every file tool takes an explicit `repo` param
 * ('backend' | 'frontend') routing it to the right sandbox; every write goes
 * through moduleGuardrails.js before touching disk.
 *
 * Deliberately its own file rather than a parameterized version of
 * runCodingAgent — phase 1's agent is proven and used unmodified every week;
 * this one has a materially different (and stricter) risk profile and
 * should be able to change without touching phase 1 at all.
 */

let client = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.aida.codingAgent.apiKey });
  return client;
}

const REPO_ENUM = { type: 'string', enum: ['backend', 'frontend'], description: 'Which repo/sandbox to operate on.' };

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "Read a text file's full contents from either sandbox, given a path relative to that sandbox's root.",
      parameters: { type: 'object', properties: { repo: REPO_ENUM, path: { type: 'string' } }, required: ['repo', 'path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file (or, only for the small set of registration files you are told about, add lines to ' +
        'an existing one) in either sandbox. Always write the COMPLETE new file content, not a diff/patch. ' +
        'Writing to any other pre-existing file is refused — see the system prompt for the exact allowed paths.',
      parameters: {
        type: 'object',
        properties: { repo: REPO_ENUM, path: { type: 'string' }, content: { type: 'string' } },
        required: ['repo', 'path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List files/directories under a path in either sandbox (node_modules and .git are always excluded).",
      parameters: {
        type: 'object',
        properties: { repo: REPO_ENUM, path: { type: 'string', description: 'Defaults to the sandbox root (".") if omitted.' }, recursive: { type: 'boolean' } },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one command (e.g. npm) with the given arguments, cwd locked to the given sandbox root. Not a shell — no pipes/redirects/chaining.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_ENUM,
          command: { type: 'string', description: 'e.g. "npm"' },
          args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["test"] or ["install"]' },
        },
        required: ['repo', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call this exactly once, when you are completely done (whether you succeeded, partially succeeded, or could not build the module). Ends the session.',
      parameters: {
        type: 'object',
        properties: {
          success: { type: 'boolean', description: 'Whether the module was actually built and verified (backend tests pass, frontend build succeeds).' },
          summary: { type: 'string', description: 'Plain-language explanation of what you built, in both repos, and anything a human needs to do manually (e.g. wiring up frontend navigation). Shown to a human reviewer.' },
        },
        required: ['success', 'summary'],
      },
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
5. HARD REQUIREMENT before calling finish with success: true, for a module (not a standalone page): if
   index.html and/or masteradmin.html appear in your insert-only list above, you MUST have already made
   BOTH of these edits yourself — a sidebar/in-page entry in index.html (rule 3b), AND a checkbox entry in
   masteradmin.html's module list (the same ALL_MODULES-style array pattern used for every other module,
   so a human can actually enable this module for a company) — before finishing. Writing "add this
   manually" in your summary for a file you had insert-only access to is a FAILURE to complete the task,
   not an acceptable shortcut — a human should never need to hand-edit either file for a module you had
   the access to wire up yourself. The ONLY acceptable reason to describe a manual step in your summary is
   a file you were NOT given insert-only access to at all.
6. Before calling finish: run the backend's test suite (run_command repo:"backend" npm test) and the
   frontend's build (run_command repo:"frontend", whatever its build script is — check package.json
   first). If either fails, keep iterating; if you truly cannot get both green, call finish anyway with
   success: false and explain what failed and why.
7. Call finish exactly once. Its summary is read directly by a human deciding whether to approve a live
   preview and push this to production — write it for that audience: what the module does, what you
   built on each side, and any manual step still genuinely needed (only for files outside your insert-only
   access — see rule 5).`;
}

/**
 * Runs the dual-sandbox agent loop. `existingFiles` and `insertOnlyFiles` are
 * { backend: Set/Array, frontend: Set/Array } — see moduleGuardrails.js.
 * `originalContents` is { backend: Map, frontend: Map } of the pre-task
 * content of each insert-only file, used to verify every write to one of
 * them only ever adds lines, never removes/changes the original ones.
 */
async function runModuleBuilderAgent({
  sandboxDirs, task, existingFiles, insertOnlyFiles = { backend: [], frontend: [] },
  originalContents = { backend: new Map(), frontend: new Map() },
  maxIterations = 40, onEvent,
}) {
  const messages = [
    { role: 'system', content: buildSystemPrompt({
      backendRegistration: (insertOnlyFiles.backend || []).map((f) => `   - backend: ${f}`).join('\n') || '   - (none configured)',
      frontendRegistration: (insertOnlyFiles.frontend || []).map((f) => `   - frontend: ${f}`).join('\n') || '   - (none configured — any frontend registration must be described in your summary for a human to do)',
    }) },
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

      const result = executeTool({ sandboxDirs, existingFiles, insertOnlyFiles, originalContents, name: call.function.name, args });
      const resolved = result instanceof Promise ? await result : result;
      toolLog.push({ tool: call.function.name, args: redactForLog(call.function.name, args), result: summarizeForLog(resolved) });
      emit({ type: 'tool', tool: call.function.name, args });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resolved).slice(0, 30_000) });
    }
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
