const jwt = require('jsonwebtoken');
const config = require('../../config');
const coreDb = require('../../db/core');
const flowStore = require('./flowStore');
const jobStore = require('../jobs/jobStore');
const { listAvailableTools, executeTool } = require('../toolRegistry');
const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');

/**
 * AIDA roadmap item 15 — the Flows execution engine. Runs a flow's steps in
 * order, resolving {{stepN.output.x}} references between them, via the
 * EXACT SAME executeTool() every chat turn already uses — a flow step is
 * nothing more than a tool call outside of a live conversation.
 */

// Mirrors routes/whatsapp.js's buildWhatsAppMasterAdminContext exactly — the
// established precedent for minting a real, short-lived masteradmin JWT +
// full AidaContext outside a live HTTP request. Here it's minted for the
// flow's OWN creator (not "whichever admin happens to be active"), since a
// flow has a specific, known owner.
async function buildFlowContext(flow) {
  const admin = await coreDb('platform_admins').where({ id: flow.createdByUserId }).first();
  if (!admin) throw new Error(`Flow ${flow.id}'s creator (platform_admins.id=${flow.createdByUserId}) no longer exists.`);
  const token = jwt.sign({ adminId: admin.id, name: admin.name, email: admin.email, role: 'masteradmin' }, config.app.jwtSecret, { expiresIn: '10m' });
  return {
    kind: 'masteradmin', tenantSlug: null, companyId: null, companyName: null,
    userId: admin.id, role: 'masteradmin', enabledModules: [MASTERADMIN_SENTINEL_MODULE],
    authHeader: `Bearer ${token}`,
    currentPage: null, currentModule: null, currentRoute: null, activeEntity: null,
  };
}

// Confirmation-gated tools where the flow AUTHOR's own step config (written
// once, reviewed at flow-creation/edit time) stands in for the live "yes" a
// chat turn would otherwise need — the risk the confirmed gate guards
// against is an LLM improvising a send mid-conversation with no human
// having seen it; a flow has no such improvisation, the masteradmin typed
// the exact message/recipient themselves. Confirmed explicitly with the
// user (2026-10-28) rather than assumed. executeSteps() force-sets
// confirmed:true when calling one of these from a flow — see below.
const FLOW_ALLOWED_CONFIRMED_TOOLS = new Set(['message_contact', 'send_email', 'reply_to_email']);

// message_contact/send_email's `includeAttachment` means "attach the file a
// human just sent AIDA in this live chat/WhatsApp conversation"
// (pendingAttachments.js — an ephemeral, session-keyed store). A flow's
// synthetic context has no such live session, so this can NEVER
// meaningfully succeed — found live 2026-10-28 when a real flow failed with
// "no recently-attached file" on every run, since there never could be one.
// Force-cleared below rather than left to fail every time.
const FLOW_FORCE_NO_ATTACHMENT_TOOLS = new Set(['message_contact', 'send_email']);

/**
 * A tool is excluded from Flows if it needs a live human `confirmed:true` in
 * THIS turn — see engine.js's own identical safety rule — UNLESS it's one of
 * FLOW_ALLOWED_CONFIRMED_TOOLS above. dev_approve_job/dev_reject_job (merges/
 * closes a real PR) and anything else gated this way stay excluded by
 * default — allowing a confirmed-gated tool in Flows is an explicit
 * allowlist decision per tool, not a blanket exception.
 */
function isFlowSafeTool(tool) {
  if (!tool.inputSchema?.properties?.confirmed) return true;
  return FLOW_ALLOWED_CONFIRMED_TOOLS.has(tool.name);
}

/** The node library — every tool Flows is allowed to use, with its full inputSchema (handler stripped before this ever reaches a route) plus its category/subcategory (real metadata declared on the tool, see toolRegistry.js) so the node palette can group them instead of showing one flat list. */
function listAvailableNodes() {
  const context = { kind: 'masteradmin', enabledModules: [] }; // isAvailable only needs context.kind for masteradmin tools — see toolRegistry.js
  return listAvailableTools(context)
    .filter(isFlowSafeTool)
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, category: t.category, subcategory: t.subcategory }));
}

// Resolves "{{step0.output.email}}" (positional — kept working for simple
// linear chains where position is unambiguous), "{{step_<stepId>.output.x}}"
// (stable, DAG-safe — refers to an exact step regardless of branching, added
// for item 16 part 3), OR "{{trigger.output.from}}"-style references — the
// latter added for WhatsApp/email-triggered flows, so a step can read what
// actually arrived (the near-universal use case being "reply to this
// sender"). Deliberately simple field-path lookup only (no
// expressions/functions) — see the plan's own "deliberately minimal" scope.
const REF_PATTERN = '\\{\\{\\s*(trigger|step\\d+|step_[a-zA-Z0-9_]+)\\.output\\.([a-zA-Z0-9_.]+)\\s*\\}\\}';
const WHOLE_REF_RE = new RegExp(`^${REF_PATTERN}$`);

function lookupRef(source, path, lookup) {
  let cur;
  if (source === 'trigger') cur = lookup.trigger;
  else if (source.startsWith('step_')) cur = lookup.stepsById[source.slice('step_'.length)];
  else cur = lookup.steps[Number(source.slice('step'.length))];
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Used only when a reference is embedded inside a larger string (not the
// whole field value) — e.g. "Present: {{step0.output.presentCount}}, Absent:
// {{step0.output.absentCount}}". A composed, human-readable message is the
// actual point of a field like this, found live 2026-10-28 when a real
// attendance-summary-by-email flow needed exactly this and couldn't do it.
function stringifyResolved(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function resolveValue(value, lookup) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const whole = WHOLE_REF_RE.exec(trimmed);
    if (whole) {
      // The ENTIRE field is one reference — return the raw resolved value
      // (number/array/object/etc., not stringified), so a field expecting
      // that real type (e.g. a step passing a number into another tool's
      // numeric arg) gets it, not a string.
      return lookupRef(whole[1], whole[2], lookup);
    }
    // One or more references embedded within other text — substitute each
    // with its stringified value, building a real composed message.
    // new RegExp(..., 'g') is constructed fresh here (not reused across
    // calls) specifically to avoid a shared regex object's lastIndex
    // carrying state between unrelated resolveValue() calls.
    return value.replace(new RegExp(REF_PATTERN, 'g'), (_m, source, path) => stringifyResolved(lookupRef(source, path, lookup)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, lookup));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, lookup);
    return out;
  }
  return value;
}

/**
 * Starts a flow run and returns the run row IMMEDIATELY (same "returns a job
 * id right away, doesn't block on the real work" shape as dev_repo_diagnose)
 * — a flow step can be slow (generate_document), so a route calling this
 * must never block the HTTP response on full completion. Execution itself
 * continues in the background via executeSteps(), fire-and-forget.
 */
async function startRun(flow, { triggeredBy, triggerPayload }) {
  const run = await flowStore.createRun({ flowId: flow.id, triggeredBy, triggerPayload });
  executeSteps(flow, run, triggerPayload).catch((e) => console.error(`[aida-flows] run ${run.id} (flow ${flow.id}) crashed:`, e));
  return run;
}

// Some tools (generate_document, dev_repo_diagnose, ...) don't return a real
// result at all — they just queue a background job and return {jobId,
// status:'queued'} immediately, same as they do in chat (where the human is
// told to ask again later). A flow has no one to ask later, so when a
// step's own result looks like this, wait right here for the REAL job to
// finish before treating the step as done, and use the job's own
// result/errorMessage as this step's true output — otherwise the NEXT step
// would only ever see {jobId, status:'queued'}, never an actual file/value.
// Flows already run in the background with no real time pressure, so
// blocking one step for a few minutes is a normal, safe tradeoff — a real
// generate_document run has taken up to 157 seconds live.
const JOB_POLL_INTERVAL_MS = 3000;
const JOB_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

async function waitForJobCompletion(jobId) {
  const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await jobStore.getJob(jobId);
    if (!job) return { error: `Job ${jobId} disappeared while waiting for it to finish.` };
    if (job.status === 'completed') return job.result || {};
    if (job.status === 'failed') return { error: job.errorMessage || `Job ${jobId} failed with no error message.` };
    await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
  }
  return { error: `Timed out after ${JOB_WAIT_TIMEOUT_MS / 1000}s waiting for job ${jobId} to finish.` };
}

/**
 * DAG execution (item 16, part 3) — replaces the old simple linear `for`
 * loop. Steps whose dependencies have all completed run concurrently
 * (Promise.all, one "wave" at a time), not strictly one-by-one — this is
 * what makes two independent root steps (e.g. a Sitara-orders fetch and a
 * Razorpay-payments fetch) genuinely run in parallel. After each wave,
 * readiness is recomputed and the next wave runs, until every step is done
 * or nothing more can become ready.
 *
 * A step whose dependency failed (or was itself skipped, or references a
 * dependency id that doesn't resolve to any real step — a stale/cyclic
 * graph) is marked `skipped`, never left hanging forever waiting for an
 * input that will never arrive. Independent branches that don't depend on
 * the failure keep running to completion regardless. The run's own final
 * status is `failed` if ANY step failed or was skipped, even when other
 * branches fully succeeded — the flow didn't do everything it was supposed
 * to, even if parts of it worked.
 *
 * Never throws; the run's own status row is the result.
 */
async function executeSteps(flow, run, triggerPayload) {
  const lookup = { trigger: triggerPayload ?? null, steps: [], stepsById: {} };
  const statusById = new Map(); // 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  flow.steps.forEach((s) => statusById.set(s.id, 'pending'));

  // A step with dependsOnStepIds === null never had this column set at all
  // (every flow created before this DAG support existed) — default it to
  // depending on the immediately preceding step by step_order, reproducing
  // v1's exact strict-linear behavior. An explicit array (including []) is
  // used as-is — see flowStore.mapStep's own comment on this distinction.
  function effectiveDeps(step, idx) {
    if (step.dependsOnStepIds === null || step.dependsOnStepIds === undefined) {
      return idx === 0 ? [] : [flow.steps[idx - 1].id];
    }
    return step.dependsOnStepIds;
  }

  function depStatus(depId) {
    return statusById.has(depId) ? statusById.get(depId) : 'missing';
  }
  function isReady(step, idx) {
    return effectiveDeps(step, idx).every((depId) => depStatus(depId) === 'completed');
  }
  function isDead(step, idx) {
    return effectiveDeps(step, idx).some((depId) => ['failed', 'skipped', 'missing'].includes(depStatus(depId)));
  }

  try {
    const context = await buildFlowContext(flow);

    async function runOneStep(step, idx) {
      statusById.set(step.id, 'running');
      const resolvedInput = resolveValue(step.config || {}, lookup);
      // The flow author's own step config IS the confirmation for these —
      // see FLOW_ALLOWED_CONFIRMED_TOOLS's own comment. The step-config form
      // never needs a "confirmed" checkbox; it's implicit in having been
      // configured as a flow step at all.
      if (FLOW_ALLOWED_CONFIRMED_TOOLS.has(step.toolName)) resolvedInput.confirmed = true;
      if (FLOW_FORCE_NO_ATTACHMENT_TOOLS.has(step.toolName)) resolvedInput.includeAttachment = false;

      let result;
      try {
        result = await executeTool(step.toolName, resolvedInput, context);
        if (result && !result.error && typeof result.jobId === 'string') {
          result = await waitForJobCompletion(result.jobId);
        }
      } catch (e) {
        result = { error: e.message };
      }

      if (result && result.error) {
        statusById.set(step.id, 'failed');
        await flowStore.recordRunStep({ flowRunId: run.id, stepId: step.id, status: 'failed', input: resolvedInput, errorMessage: result.error });
        return;
      }

      statusById.set(step.id, 'completed');
      await flowStore.recordRunStep({ flowRunId: run.id, stepId: step.id, status: 'completed', input: resolvedInput, output: result });
      lookup.steps[idx] = result; // positional — keeps old {{stepN...}} working
      lookup.stepsById[step.id] = result;
    }

    let progressed = true;
    while (progressed) {
      progressed = false;

      const dead = flow.steps.filter((s, idx) => statusById.get(s.id) === 'pending' && isDead(s, idx));
      if (dead.length) {
        progressed = true;
        for (const s of dead) {
          statusById.set(s.id, 'skipped');
          await flowStore.recordRunStep({ flowRunId: run.id, stepId: s.id, status: 'skipped', errorMessage: "Skipped — an upstream dependency failed, was itself skipped, or doesn't resolve to a real step." });
        }
      }

      const ready = flow.steps.filter((s, idx) => statusById.get(s.id) === 'pending' && isReady(s, idx));
      if (ready.length) {
        progressed = true;
        await Promise.all(ready.map((s) => runOneStep(s, flow.steps.indexOf(s))));
      }
    }

    // Safety net: anything still 'pending' here means its dependency graph
    // never resolved (a genuine cycle — two steps each waiting on the
    // other) — mark it skipped rather than silently vanishing from the run.
    const stillPending = flow.steps.filter((s) => statusById.get(s.id) === 'pending');
    for (const s of stillPending) {
      statusById.set(s.id, 'skipped');
      await flowStore.recordRunStep({ flowRunId: run.id, stepId: s.id, status: 'skipped', errorMessage: "Skipped — this step's dependencies form a cycle and could never be satisfied." });
    }

    const failed = flow.steps.filter((s) => statusById.get(s.id) === 'failed').map((s) => s.toolName);
    const skipped = flow.steps.filter((s) => statusById.get(s.id) === 'skipped').map((s) => s.toolName);
    if (failed.length || skipped.length) {
      const parts = [];
      if (failed.length) parts.push(`failed: ${failed.join(', ')}`);
      if (skipped.length) parts.push(`skipped: ${skipped.join(', ')}`);
      await flowStore.updateRunStatus(run.id, 'failed', { errorMessage: `One or more steps did not complete (${parts.join('; ')}).` });
    } else {
      await flowStore.updateRunStatus(run.id, 'completed');
    }
  } catch (e) {
    console.error(`[aida-flows] run ${run.id} (flow ${flow.id}) failed:`, e);
    await flowStore.updateRunStatus(run.id, 'failed', { errorMessage: e.message });
  }
}

// ── Schedule trigger ─────────────────────────────────────────────────────
// Same "poll, check if enough time has passed, act" convention as
// sitaraWeeklyReconciliation.js — no cron dependency, nothing else in this
// codebase uses one either (confirmed before writing this).
const SCHEDULE_CHECK_INTERVAL_MS = 60 * 1000;
const lastRunAtByFlowId = new Map(); // in-memory — a missed tick across a restart just means one run fires a bit late, not a correctness issue

function isScheduleDue(flow) {
  const cfg = flow.triggerConfig || {};
  const last = lastRunAtByFlowId.get(flow.id) || 0;
  const now = Date.now();
  if (cfg.everyMinutes) return now - last >= cfg.everyMinutes * 60 * 1000;
  if (cfg.dailyAt) {
    const [h, m] = String(cfg.dailyAt).split(':').map(Number);
    const target = new Date();
    target.setHours(h || 0, m || 0, 0, 0);
    return now >= target.getTime() && now - last >= 20 * 60 * 60 * 1000; // won't double-fire within the same day
  }
  return false; // no recognized schedule shape — never fires rather than guessing
}

let scheduleTimer = null;
async function checkSchedules() {
  try {
    const flows = await flowStore.listActiveScheduledFlows();
    for (const flow of flows) {
      if (!isScheduleDue(flow)) continue;
      lastRunAtByFlowId.set(flow.id, Date.now());
      const full = await flowStore.getFlow(flow.id); // listActiveScheduledFlows doesn't include steps
      startRun(full, { triggeredBy: 'schedule' }).catch((e) => console.error(`[aida-flows] scheduled run of flow ${flow.id} failed:`, e.message));
    }
  } catch (e) {
    console.error('[aida-flows] schedule check failed:', e.message);
  }
}

function start() {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(checkSchedules, SCHEDULE_CHECK_INTERVAL_MS);
  scheduleTimer.unref?.();
}

// ── WhatsApp / email triggers ────────────────────────────────────────────
// Deliberately NOT new webhook endpoints — this app already has exactly one
// WhatsApp webhook (Meta allows only one per Business Account) and no
// inbound-email webhook at all (mail arrives via Microsoft Graph polling,
// not a push). These two functions are called as a side effect from INSIDE
// those two existing, already-authenticated pipelines
// (routes/whatsapp.js's POST /webhook handler, emailMonitor.js's
// processMessage()) — see the plan's own "Item 15 extension" section for
// why. Plain substring/equality matching only, same "no condition engine"
// philosophy as the rest of Flows v1. Fire-and-forget by design: a bug here
// must never break AIDA's own WhatsApp reply or the email summarizer.

async function checkWhatsAppTriggers({ from, body }) {
  try {
    const candidates = await flowStore.listActiveFlowsByTriggerType('whatsapp');
    for (const candidate of candidates) {
      const cfg = candidate.triggerConfig || {};
      if (cfg.matchPhone && cfg.matchPhone !== from) continue;
      if (cfg.matchKeyword && !String(body || '').toLowerCase().includes(String(cfg.matchKeyword).toLowerCase())) continue;
      const flow = await flowStore.getFlow(candidate.id); // listActiveFlowsByTriggerType doesn't include steps
      startRun(flow, { triggeredBy: 'whatsapp', triggerPayload: { from, body } })
        .catch((e) => console.error(`[aida-flows] whatsapp-triggered run of flow ${candidate.id} failed:`, e.message));
    }
  } catch (e) {
    console.error('[aida-flows] checkWhatsAppTriggers failed:', e.message);
  }
}

async function checkEmailTriggers({ from, subject, body }) {
  try {
    const candidates = await flowStore.listActiveFlowsByTriggerType('email');
    for (const candidate of candidates) {
      const cfg = candidate.triggerConfig || {};
      if (cfg.matchFromAddress && !String(from || '').toLowerCase().includes(String(cfg.matchFromAddress).toLowerCase())) continue;
      if (cfg.matchSubjectContains && !String(subject || '').toLowerCase().includes(String(cfg.matchSubjectContains).toLowerCase())) continue;
      const flow = await flowStore.getFlow(candidate.id);
      startRun(flow, { triggeredBy: 'email', triggerPayload: { from, subject, body } })
        .catch((e) => console.error(`[aida-flows] email-triggered run of flow ${candidate.id} failed:`, e.message));
    }
  } catch (e) {
    console.error('[aida-flows] checkEmailTriggers failed:', e.message);
  }
}

module.exports = { startRun, listAvailableNodes, start, checkWhatsAppTriggers, checkEmailTriggers };
