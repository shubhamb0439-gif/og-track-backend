/* =============================================================================
   PATCH: ai_flows, ai_flow_steps, ai_flow_runs, ai_flow_run_steps — AIDA
   roadmap item 15: masteradmin-only workflow automation (n8n-style)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   every other patch_*.sql file. Idempotent — wrapped in an existence guard
   per table (previously claimed idempotent without actually being so — a
   plain CREATE TABLE with no guard — fixed 2026-10-28 after that bit a real
   re-run; see patch_17_ai_flows_whatsapp_email_triggers.sql, which migrates
   a set of these tables already created by this file's earlier, unguarded
   version).

   Structurally mirrors aida_jobs/aida_job_events (01_platform_core.sql) —
   adapted for a REUSABLE, ordered, multi-step definition (a "flow") that can
   be run many times, rather than aida_jobs' one-shot model. A flow's own
   run history lives in ai_flow_runs/ai_flow_run_steps, separate from
   aida_jobs — a flow run isn't an aida_job (it doesn't need
   approval/rejection, a job kind, or jobRunner's polling dispatch; it has
   its own execution engine, see src/aida/flows/flowRunner.js).

   v1 scope (see the plan's own Item 15 for the full reasoning): linear
   steps only (step_order, no branching), five trigger types (manual/
   schedule/webhook/whatsapp/email) via trigger_type + trigger_config_json,
   and a simple {{stepN.output.field}} / {{trigger.output.field}} reference
   syntax in each step's config_json, resolved by the engine at run time —
   not stored as its own column/table.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_flows', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_flows (
        id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
        name                NVARCHAR(200)  NOT NULL,
        description         NVARCHAR(500)  NULL,
        trigger_type        NVARCHAR(20)   NOT NULL,   -- manual | schedule | webhook | whatsapp | email
        trigger_config_json NVARCHAR(MAX)  NULL,        -- e.g. {"everyMinutes":60} or {"dailyAt":"09:00"} or {"webhookSecret":"..."} or {"matchPhone":"...", "matchKeyword":"..."} or {"matchFromAddress":"...", "matchSubjectContains":"..."}
        status              NVARCHAR(20)   NOT NULL DEFAULT 'active',  -- active | paused
        created_by_user_id  NVARCHAR(64)   NOT NULL,     -- the masteradmin who owns this flow — also whose identity/permissions a run executes as
        created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_ai_flows_trigger_type CHECK (trigger_type IN ('manual','schedule','webhook','whatsapp','email')),
        CONSTRAINT CK_ai_flows_status CHECK (status IN ('active','paused')),
        CONSTRAINT CK_ai_flows_trigger_config_json CHECK (trigger_config_json IS NULL OR ISJSON(trigger_config_json) = 1)
    );
    CREATE INDEX IX_ai_flows_status ON dbo.ai_flows(status);
END
GO

IF OBJECT_ID('dbo.ai_flow_steps', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_flow_steps (
        id          NVARCHAR(64)   NOT NULL PRIMARY KEY,
        flow_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.ai_flows(id),
        step_order  INT            NOT NULL,
        tool_name   NVARCHAR(100)  NOT NULL,   -- a name from toolRegistry.js's catalog (see GET /flows/available-nodes)
        config_json NVARCHAR(MAX)  NULL,        -- literal arg values and/or {{stepN.output.x}}/{{trigger.output.x}} references, resolved at run time
        created_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_ai_flow_steps_config_json CHECK (config_json IS NULL OR ISJSON(config_json) = 1)
    );
    CREATE INDEX IX_ai_flow_steps_flow ON dbo.ai_flow_steps(flow_id, step_order);
END
GO

IF OBJECT_ID('dbo.ai_flow_runs', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_flow_runs (
        id                   NVARCHAR(64)   NOT NULL PRIMARY KEY,
        flow_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.ai_flows(id),
        status               NVARCHAR(20)   NOT NULL DEFAULT 'running',  -- running | completed | failed
        triggered_by         NVARCHAR(20)   NOT NULL,                     -- manual | schedule | webhook | whatsapp | email
        trigger_payload_json NVARCHAR(MAX)  NULL,  -- the real inbound message/email that caused this run (whatsapp/email triggers only) — resolved via {{trigger.output.x}}
        error_message        NVARCHAR(MAX)  NULL,
        started_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        finished_at          DATETIME2      NULL,
        CONSTRAINT CK_ai_flow_runs_status CHECK (status IN ('running','completed','failed')),
        CONSTRAINT CK_ai_flow_runs_triggered_by CHECK (triggered_by IN ('manual','schedule','webhook','whatsapp','email')),
        CONSTRAINT CK_ai_flow_runs_trigger_payload_json CHECK (trigger_payload_json IS NULL OR ISJSON(trigger_payload_json) = 1)
    );
    CREATE INDEX IX_ai_flow_runs_flow ON dbo.ai_flow_runs(flow_id, started_at DESC);
END
GO

IF OBJECT_ID('dbo.ai_flow_run_steps', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_flow_run_steps (
        id            NVARCHAR(64)   NOT NULL PRIMARY KEY,
        flow_run_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.ai_flow_runs(id),
        step_id       NVARCHAR(64)   NOT NULL REFERENCES dbo.ai_flow_steps(id),
        status        NVARCHAR(20)   NOT NULL,   -- completed | failed
        input_json    NVARCHAR(MAX)  NULL,        -- the step's config AFTER {{...}} references were resolved — what actually ran
        output_json   NVARCHAR(MAX)  NULL,
        error_message NVARCHAR(MAX)  NULL,
        started_at    DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        finished_at   DATETIME2      NULL,
        CONSTRAINT CK_ai_flow_run_steps_status CHECK (status IN ('completed','failed')),
        CONSTRAINT CK_ai_flow_run_steps_input_json CHECK (input_json IS NULL OR ISJSON(input_json) = 1),
        CONSTRAINT CK_ai_flow_run_steps_output_json CHECK (output_json IS NULL OR ISJSON(output_json) = 1)
    );
    CREATE INDEX IX_ai_flow_run_steps_run ON dbo.ai_flow_run_steps(flow_run_id);
END
GO
