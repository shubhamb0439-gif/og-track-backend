const coreDb = require('../../db/core');

/**
 * All DB access for AIDA Flows (roadmap item 15) — mirrors jobStore.js's own
 * separation (routes/flowRunner call helpers, helpers own the schema shape).
 * See patch_16_ai_flows.sql for the table shapes this maps to/from.
 */

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapFlow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config_json ? JSON.parse(row.trigger_config_json) : null,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    flowId: row.flow_id,
    stepOrder: row.step_order,
    toolName: row.tool_name,
    config: row.config_json ? JSON.parse(row.config_json) : {},
    // DAG scheduling (item 16, part 3) — ids of other steps in the SAME flow
    // this one depends on. Three distinct states, kept distinguishable on
    // purpose: `null` = never specified at all (every flow created before
    // this column existed) — flowRunner.js defaults this to "depends on the
    // immediately preceding step," preserving v1's exact strict-linear
    // behavior. `[]` = explicitly no dependency (a parallel root step, set
    // deliberately by a DAG-aware caller). A non-empty array = real
    // dependencies.
    dependsOnStepIds: row.depends_on_step_ids === null || row.depends_on_step_ids === undefined
      ? null
      : JSON.parse(row.depends_on_step_ids),
    createdAt: row.created_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    flowId: row.flow_id,
    status: row.status,
    triggeredBy: row.triggered_by,
    triggerPayload: row.trigger_payload_json ? JSON.parse(row.trigger_payload_json) : null,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapRunStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    flowRunId: row.flow_run_id,
    stepId: row.step_id,
    status: row.status,
    input: row.input_json ? JSON.parse(row.input_json) : null,
    output: row.output_json ? JSON.parse(row.output_json) : null,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Creates a flow AND its steps in one call — a flow is never meaningfully "created" without at least its step list. */
async function createFlow({ name, description, triggerType, triggerConfig, createdByUserId, steps }) {
  const id = newId('flow');
  await coreDb('ai_flows').insert({
    id, name, description: description || null,
    trigger_type: triggerType,
    trigger_config_json: triggerConfig ? JSON.stringify(triggerConfig) : null,
    status: 'active',
    created_by_user_id: createdByUserId,
  });
  await replaceSteps(id, steps || []);
  return getFlow(id);
}

/**
 * Replaces a flow's full step list. Each incoming step may include
 * `dependsOn`: an array of INDICES into this same `steps` array (not real
 * ids — the caller, e.g. a graph-canvas frontend, only knows these steps by
 * their position in the array it's submitting, never their not-yet-assigned
 * real ids). Real step ids are generated for every step FIRST, so both
 * forward and backward index references resolve, then persisted as the
 * real-id JSON array `dependsOnStepIds` the DAG engine actually runs on.
 * Omitted/empty `dependsOn` means "no dependency, ready immediately" — the
 * old step_order remains purely for the frontend's visual layout.
 */
async function replaceSteps(flowId, steps) {
  // Same FK-safe ordering deleteFlow() already needed, for the same reason:
  // ai_flow_run_steps.step_id hard-references ai_flow_steps(id), so once a
  // flow has been run even once, saving an edit (which always replaces every
  // step with a freshly-generated id — see this function's own doc comment)
  // would otherwise violate that FK on the DELETE below. Those old run-step
  // rows are about a step definition that no longer exists after this edit
  // anyway (its tool/config may have changed), so their per-step detail is
  // discarded here; each run's own summary row (ai_flow_runs — status,
  // triggered_by, started/finished times) is untouched and stays in history.
  const oldStepIds = (await coreDb('ai_flow_steps').where({ flow_id: flowId }).select('id')).map((r) => r.id);
  if (oldStepIds.length) await coreDb('ai_flow_run_steps').whereIn('step_id', oldStepIds).delete();
  await coreDb('ai_flow_steps').where({ flow_id: flowId }).delete();
  const ids = steps.map(() => newId('flowstep'));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Distinguish "dependsOn omitted entirely" (store NULL — flowRunner.js
    // falls back to v1's implicit strict-linear order) from "dependsOn
    // explicitly an empty array" (store the JSON "[]" — a deliberate
    // parallel-root step) — see mapStep's comment for why this distinction
    // matters.
    const dependsOnJson = Array.isArray(step.dependsOn)
      ? JSON.stringify(step.dependsOn.map((idx) => ids[idx]).filter(Boolean))
      : null;
    await coreDb('ai_flow_steps').insert({
      id: ids[i],
      flow_id: flowId,
      step_order: i,
      tool_name: step.toolName,
      config_json: step.config ? JSON.stringify(step.config) : null,
      depends_on_step_ids: dependsOnJson,
    });
  }
}

async function getFlow(id) {
  const flow = mapFlow(await coreDb('ai_flows').where({ id }).first());
  if (!flow) return null;
  flow.steps = await listStepsForFlow(id);
  return flow;
}

async function listStepsForFlow(flowId) {
  const rows = await coreDb('ai_flow_steps').where({ flow_id: flowId }).orderBy('step_order', 'asc');
  return rows.map(mapStep);
}

async function listFlows({ status } = {}) {
  let q = coreDb('ai_flows');
  if (status) q = q.where({ status });
  const rows = await q.orderBy('created_at', 'desc');
  return rows.map(mapFlow);
}

/** For the schedule-trigger poller — only ever needs active, schedule-type flows. */
async function listActiveScheduledFlows() {
  return listActiveFlowsByTriggerType('schedule');
}

/** Generalized — used by the WhatsApp/email trigger checks too (checkWhatsAppTriggers/checkEmailTriggers in flowRunner.js). Returns flows WITHOUT steps (same lightweight shape as listFlows) — callers that need to actually run one fetch its full detail via getFlow() afterward. */
async function listActiveFlowsByTriggerType(triggerType) {
  const rows = await coreDb('ai_flows').where({ status: 'active', trigger_type: triggerType });
  return rows.map(mapFlow);
}

async function updateFlow(id, { name, description, triggerConfig, status, steps }) {
  const updates = { updated_at: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (triggerConfig !== undefined) updates.trigger_config_json = triggerConfig ? JSON.stringify(triggerConfig) : null;
  if (status !== undefined) updates.status = status;
  await coreDb('ai_flows').where({ id }).update(updates);
  if (steps !== undefined) await replaceSteps(id, steps);
  return getFlow(id);
}

/**
 * Full cascade delete — found live (2026-10-28) that the original version of
 * this function was simply broken: `ai_flow_steps.flow_id` has a hard FK
 * back to `ai_flows`, so a flow could never actually be deleted while any of
 * its steps existed (and a flow always has at least one step). Keeping run
 * history around for a flow that no longer exists isn't useful anyway —
 * there'd be nothing left to navigate to it from — so this deletes the
 * whole chain in FK-safe order: run steps -> runs -> steps -> the flow
 * itself, matching the ordinary "delete this workflow" expectation (same as
 * n8n's own default behavior) rather than a confusing partial delete.
 */
async function deleteFlow(id) {
  const runs = await coreDb('ai_flow_runs').where({ flow_id: id }).select('id');
  const runIds = runs.map((r) => r.id);
  if (runIds.length) await coreDb('ai_flow_run_steps').whereIn('flow_run_id', runIds).delete();
  await coreDb('ai_flow_runs').where({ flow_id: id }).delete();
  await coreDb('ai_flow_steps').where({ flow_id: id }).delete();
  await coreDb('ai_flows').where({ id }).delete();
}

async function createRun({ flowId, triggeredBy, triggerPayload }) {
  const id = newId('flowrun');
  await coreDb('ai_flow_runs').insert({
    id, flow_id: flowId, status: 'running', triggered_by: triggeredBy,
    trigger_payload_json: triggerPayload !== undefined ? JSON.stringify(triggerPayload) : null,
  });
  return getRun(id);
}

async function getRun(id) {
  return mapRun(await coreDb('ai_flow_runs').where({ id }).first());
}

async function updateRunStatus(id, status, { errorMessage } = {}) {
  const updates = { status };
  if (status !== 'running') updates.finished_at = new Date();
  if (errorMessage !== undefined) updates.error_message = errorMessage;
  await coreDb('ai_flow_runs').where({ id }).update(updates);
  return getRun(id);
}

async function listRunsForFlow(flowId, limit = 20) {
  const rows = await coreDb('ai_flow_runs').where({ flow_id: flowId }).orderBy('started_at', 'desc').limit(limit);
  return rows.map(mapRun);
}

async function recordRunStep({ flowRunId, stepId, status, input, output, errorMessage }) {
  const id = newId('flowrunstep');
  await coreDb('ai_flow_run_steps').insert({
    id, flow_run_id: flowRunId, step_id: stepId, status,
    input_json: input !== undefined ? JSON.stringify(input) : null,
    output_json: output !== undefined ? JSON.stringify(output) : null,
    error_message: errorMessage || null,
    finished_at: new Date(),
  });
  return id;
}

async function listStepsForRun(flowRunId) {
  const rows = await coreDb('ai_flow_run_steps').where({ flow_run_id: flowRunId }).orderBy('started_at', 'asc');
  return rows.map(mapRunStep);
}

module.exports = {
  createFlow, getFlow, listFlows, listActiveScheduledFlows, listActiveFlowsByTriggerType, updateFlow, deleteFlow,
  createRun, getRun, updateRunStatus, listRunsForFlow, recordRunStep, listStepsForRun,
};
