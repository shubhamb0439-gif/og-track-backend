/* =============================================================================
   PATCH: ai_email_log — AIDA roadmap item 8.2 (reply to a watched email)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_02_ai_email_monitor_state.sql. Idempotent — safe to re-run.

   Context: emailMonitor.js's processMessage() previously threw away the
   Graph message id/sender/subject the moment each poll cycle finished —
   fine for a one-way summary, but a later "reply to them" WhatsApp
   instruction needs something durable to resolve against. One row per
   processed message that matched a watched recipient; not a general mail
   archive, just enough to reply to the most recent (or a specific) one.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_email_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_email_log (
        id                NVARCHAR(40)   NOT NULL PRIMARY KEY,
        graph_message_id  NVARCHAR(400)  NOT NULL,
        watched_address   NVARCHAR(200)  NOT NULL,
        from_address      NVARCHAR(200)  NULL,
        subject           NVARCHAR(500)  NULL,
        summary           NVARCHAR(MAX)  NULL,
        is_urgent         BIT            NOT NULL DEFAULT 0,
        created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
