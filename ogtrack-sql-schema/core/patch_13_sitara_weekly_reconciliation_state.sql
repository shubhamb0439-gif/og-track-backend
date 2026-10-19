/* =============================================================================
   PATCH: ai_sitara_weekly_reconciliation_state — weekly Razorpay-vs-orders
   reconciliation email (src/sitaraWeeklyReconciliation.js)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_02_ai_email_monitor_state.sql. Idempotent — safe to re-run.

   Single row, fixed id — persists only the last time the weekly reconciliation
   report was actually sent, so a server restart (or the hourly check tick)
   doesn't re-send the report mid-week.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_sitara_weekly_reconciliation_state', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_sitara_weekly_reconciliation_state (
        id           NVARCHAR(20)   NOT NULL PRIMARY KEY,
        last_run_at  DATETIME2      NULL,
        updated_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
