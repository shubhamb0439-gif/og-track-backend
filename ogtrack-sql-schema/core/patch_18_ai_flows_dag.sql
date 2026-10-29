/* =============================================================================
   PATCH: ai_flow_steps — add depends_on_step_ids (AIDA roadmap item 16, part 3:
   Flows v2 DAG/branching execution)
   =============================================================================
   Run against OGCore itself (NOT a tenant database). Idempotent — safe to
   re-run.

   Context: Flows v1 (patch_16/17) only ever ran steps in a strict linear
   chain (step_order 0,1,2,...). This adds the one column the new DAG
   scheduler needs: a JSON array of other step ids (within the SAME flow)
   this step depends on. NULL/empty means "no dependency, runs immediately"
   — multiple steps with no dependencies is exactly how two independent
   branches (e.g. a Sitara-orders fetch and a Razorpay-payments fetch) both
   start in parallel. step_order is unchanged and stays as-is, now purely
   for the frontend's visual layout rather than execution order.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_flow_steps') AND name = 'depends_on_step_ids')
    ALTER TABLE dbo.ai_flow_steps ADD depends_on_step_ids NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_flow_steps_depends_on_step_ids')
    ALTER TABLE dbo.ai_flow_steps ADD CONSTRAINT CK_ai_flow_steps_depends_on_step_ids CHECK (depends_on_step_ids IS NULL OR ISJSON(depends_on_step_ids) = 1);
GO

-- The DAG scheduler marks a step 'skipped' (not run at all) when an upstream
-- dependency failed, was itself skipped, or references a step id that
-- doesn't resolve — the original CHECK only allowed completed|failed.
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_flow_run_steps_status')
    ALTER TABLE dbo.ai_flow_run_steps DROP CONSTRAINT CK_ai_flow_run_steps_status;
GO
ALTER TABLE dbo.ai_flow_run_steps ADD CONSTRAINT CK_ai_flow_run_steps_status CHECK (status IN ('completed','failed','skipped'));
GO
