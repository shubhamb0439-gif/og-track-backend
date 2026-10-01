const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const tools = require('../tools');
const browserless = require('../browserless');
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
    name: 'inspect_website',
    description: 'Crawls a real website (up to `maxPages` same-origin pages, default 15) via a hosted headless browser and saves its content (files land in the given repo\'s sandbox). Does NOT return full page content inline — it saves each page\'s cleaned HTML and a screenshot as files under _website_inspection/, and returns only a short index (url, title, a short text preview, a list of real image URLs found on the page, and file paths). Use read_file on the returned htmlFile path(s) to pull full content for whichever specific page(s) you actually need, and download_file on the returned image URLs to get the site\'s ACTUAL images into your replica. Use this before building a page/module that replicates or redesigns an existing website — never guess at a site\'s structure/content without inspecting it first.',
    input_schema: {
      type: 'object',
      properties: {
        repo: REPO_ENUM,
        url: { type: 'string', description: 'The starting URL to inspect, e.g. "https://example.com".' },
        maxPages: { type: 'integer', description: 'Max same-origin pages to crawl (default 15) — use a smaller number for a single-page task.' },
      },
      required: ['repo', 'url'],
    },
  },
  {
    name: 'download_file',
    description: 'Downloads a real file from an external http(s) URL (e.g. one of the image URLs inspect_website returned) into the given repo\'s sandbox, as a real, correctly-encoded binary file. Unlike write_file (which always encodes as text and would corrupt binary content), this is the ONLY way to get a real image/asset\'s actual bytes into the sandbox — use it whenever a replica needs to include the site\'s real images rather than just referencing the original site\'s URL.',
    input_schema: {
      type: 'object',
      properties: {
        repo: REPO_ENUM,
        url: { type: 'string', description: 'Absolute http(s) URL to download.' },
        path: { type: 'string', description: 'Where to save it, relative to that repo\'s sandbox root, e.g. "images/logo.png".' },
      },
      required: ['repo', 'url', 'path'],
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
   access — see rule 5).

If your task is to replicate or redesign an existing website: use inspect_website FIRST — never guess at
or paraphrase a site's real structure/content/images from memory. "1:1 replica" means reproduce what you
actually captured as faithfully as possible, INCLUDING using download_file to get its real images into the
sandbox — referencing the original site's own image URL is not a replica of the image, it's just a link
back to the original site. "Better-looking version" means keep the same content and information
architecture but improve the visual design — same inspection step, different instruction on what to do
with what you found.`;
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
      case 'inspect_website':
        return browserless.inspectWebsite(sandboxDir, args.url, { maxPages: args.maxPages || 15 }).catch((e) => ({ error: e.message }));
      case 'download_file': {
        // Same guardrail check write_file gets, above — download_file writes
        // to an arbitrary agent-chosen path just like write_file does, and
        // without this an agent could silently overwrite any real existing
        // file (e.g. src/config.js) with downloaded binary content.
        assertModuleWriteAllowed({
          relPath: args.path,
          content: '', // binary/unknown content — the only content-based check here is the destructive-SQL regex, which doesn't apply to a downloaded asset
          existingFiles: existingFiles[repo],
          insertOnlyFiles: insertOnlyFiles[repo] || [],
          previousContent: originalContents[repo]?.get(normalizeForLookup(args.path)),
        });
        return tools.downloadFile(sandboxDir, args.path, args.url).catch((e) => ({ error: e.message }));
      }
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
