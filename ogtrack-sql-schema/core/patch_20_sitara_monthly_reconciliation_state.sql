/* =============================================================================
   PATCH: ai_sitara_monthly_reconciliation_state — monthly Razorpay-vs-orders
   reconciliation email (src/sitaraMonthlyReconciliation.js)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_13_sitara_weekly_reconciliation_state.sql. Idempotent — safe to re-run.

   Single row, fixed id — persists only the (calendar) month the monthly
   reconciliation report was last sent for, so a server restart or the hourly
   check tick doesn't re-send the same month's report twice.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_sitara_monthly_reconciliation_state', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_sitara_monthly_reconciliation_state (
        id              NVARCHAR(20)   NOT NULL PRIMARY KEY,
        last_sent_month NVARCHAR(7)    NULL, -- 'YYYY-MM' of the last month a report was sent FOR
        last_run_at     DATETIME2      NULL,
        updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
