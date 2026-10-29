/* =============================================================================
   PATCH: ai_flows / ai_flow_runs — widen trigger_type to allow whatsapp/email,
   add ai_flow_runs.trigger_payload_json (AIDA roadmap item 15 extension)
   =============================================================================
   Run against OGCore itself (NOT a tenant database). Idempotent — safe to
   re-run.

   Context: patch_16_ai_flows.sql was already run against this database
   BEFORE the whatsapp/email trigger extension was designed, so its tables
   exist with the ORIGINAL narrower trigger_type/triggered_by CHECK
   constraints and without trigger_payload_json. patch_16_ai_flows.sql in
   the repo was updated to match the new shape, but CREATE TABLE can't
   retroactively apply to a table that already exists — this patch brings
   an already-created set of tables up to date instead, without touching
   any existing rows.
   ============================================================================= */

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_flows_trigger_type')
    ALTER TABLE dbo.ai_flows DROP CONSTRAINT CK_ai_flows_trigger_type;
GO
ALTER TABLE dbo.ai_flows ADD CONSTRAINT CK_ai_flows_trigger_type CHECK (trigger_type IN ('manual','schedule','webhook','whatsapp','email'));
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_flow_runs_triggered_by')
    ALTER TABLE dbo.ai_flow_runs DROP CONSTRAINT CK_ai_flow_runs_triggered_by;
GO
ALTER TABLE dbo.ai_flow_runs ADD CONSTRAINT CK_ai_flow_runs_triggered_by CHECK (triggered_by IN ('manual','schedule','webhook','whatsapp','email'));
GO

-- Split into two batches deliberately: SQL Server compiles an entire batch
-- before executing any of it, so a CHECK constraint referencing a column
-- added earlier in the SAME batch fails with "Invalid column name" even
-- though the ADD COLUMN would have already run by the time it's reached —
-- the GO below forces the column to actually exist before the next batch
-- (the constraint) is even compiled.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_flow_runs') AND name = 'trigger_payload_json')
    ALTER TABLE dbo.ai_flow_runs ADD trigger_payload_json NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_flow_runs_trigger_payload_json')
    ALTER TABLE dbo.ai_flow_runs ADD CONSTRAINT CK_ai_flow_runs_trigger_payload_json CHECK (trigger_payload_json IS NULL OR ISJSON(trigger_payload_json) = 1);
GO
