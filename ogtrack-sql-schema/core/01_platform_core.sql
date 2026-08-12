/* =============================================================================
   OGCORE DATABASE — Platform-level tables that are NOT tenant-scoped.

   This is the first tracked schema file for OGCore itself — companies,
   platform_admins, and provisioning_log already exist in OGCore but were
   created ad hoc and have no tracked DDL in this repo. This file follows the
   same conventions as the ogtrack-sql-schema/tenant SQL files (NVARCHAR
   string PKs generated in application code, extra_json-free here since
   these rows are fully structured, DATETIME2/SYSUTCDATETIME() for
   timestamps) without touching any existing OGCore table.

   Run this against OGCore itself (NOT a tenant database).
   ============================================================================= */

/* ---------------------------------------------------------------------------
   aida_jobs — AIDA's async job model. A "job" is anything AIDA does that
   can't finish inside one chat request/response cycle (repo diagnosis,
   code fixes, cross-tenant writes, new-app deployment, ...). Kept in OGCore
   (not a tenant DB) because most jobs are master-admin-initiated and many
   aren't scoped to any single tenant at all (e.g. diagnosing OG Track's own
   source repo).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.aida_jobs (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    kind                NVARCHAR(50)   NOT NULL,       -- 'noop' | 'noop_gated' | (later) 'dev_diagnose' | 'dev_fix' | ...
    status              NVARCHAR(20)   NOT NULL DEFAULT 'queued',
                         -- queued | running | awaiting_approval | approved | rejected | completed | failed
    company_slug        NVARCHAR(100)  NULL,           -- target tenant, if this job is scoped to one; NULL otherwise
    created_by_user_id  NVARCHAR(64)   NOT NULL,        -- master admin's adminId (later: any AIDA power user's id)
    payload_json        NVARCHAR(MAX)  NULL,            -- job-kind-specific input
    result_json         NVARCHAR(MAX)  NULL,            -- job-kind-specific output once completed
    error_message       NVARCHAR(MAX)  NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_aida_jobs_status CHECK (status IN ('queued','running','awaiting_approval','approved','rejected','completed','failed')),
    CONSTRAINT CK_aida_jobs_payload_json CHECK (payload_json IS NULL OR ISJSON(payload_json) = 1),
    CONSTRAINT CK_aida_jobs_result_json CHECK (result_json IS NULL OR ISJSON(result_json) = 1)
);
GO
CREATE INDEX IX_aida_jobs_status ON dbo.aida_jobs(status);
GO
CREATE INDEX IX_aida_jobs_created_by ON dbo.aida_jobs(created_by_user_id);
GO

/* ---------------------------------------------------------------------------
   aida_job_events — append-only timeline per job, same shape/purpose as the
   existing dbo.provisioning_log pattern (see src/utils/provisioning.js) for
   "long background operation with a status trail" — new table, same idea.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.aida_job_events (
    id          NVARCHAR(64)   NOT NULL PRIMARY KEY,
    job_id      NVARCHAR(64)   NOT NULL REFERENCES dbo.aida_jobs(id),
    event       NVARCHAR(50)   NOT NULL,   -- queued | started | awaiting_approval | approved | rejected | completed | failed
    detail      NVARCHAR(MAX)  NULL,
    created_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_aida_job_events_detail_json CHECK (detail IS NULL OR ISJSON(detail) = 1)
);
GO
CREATE INDEX IX_aida_job_events_job ON dbo.aida_job_events(job_id);
GO
