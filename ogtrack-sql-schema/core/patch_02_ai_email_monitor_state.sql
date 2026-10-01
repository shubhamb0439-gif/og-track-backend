/* =============================================================================
   PATCH: ai_email_monitor_state — AIDA roadmap item 3 (email monitoring)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_01_aida_memory.sql. Idempotent — safe to re-run.

   Context: Microsoft Graph's mailbox "delta query" returns a `@odata.deltaLink`
   cursor after each page of results — resubmitting that same URL next time
   returns only messages that changed since. This table persists that one
   cursor so a server restart doesn't reprocess (and re-notify on) the whole
   mailbox. Single row, fixed id — there is exactly one mailbox being watched
   (config.microsoftGraph.mailbox), not one row per tenant/company.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_email_monitor_state', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_email_monitor_state (
        id           NVARCHAR(20)   NOT NULL PRIMARY KEY,
        delta_link   NVARCHAR(MAX)  NULL,
        updated_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
