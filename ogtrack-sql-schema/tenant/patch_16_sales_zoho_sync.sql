/* =============================================================================
   PATCH: sales — Zoho Books invoice sync status (AIDA roadmap item 5)
   =============================================================================
   Run against an existing tenant DB that already has 11_module_sales.sql
   applied. Idempotent — safe to re-run.

   Context: one-way push, OG Track -> Zoho, after a local sale is created
   (src/routes/sales.js's POST /). Best-effort, same convention as every
   other outbound integration in this codebase (BigCommerce, Razorpay) — a
   Zoho failure never blocks or rolls back the local sale, just logs and is
   visible via these columns for later retry/visibility. zoho_sync_status is
   nullable rather than defaulted to a string — null means "this company has
   no Zoho connection, push was never attempted", distinct from a real
   'failed' attempt.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sales') AND name = 'zoho_invoice_id')
    ALTER TABLE dbo.sales ADD zoho_invoice_id NVARCHAR(50) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sales') AND name = 'zoho_sync_status')
    ALTER TABLE dbo.sales ADD zoho_sync_status NVARCHAR(20) NULL; -- 'synced' | 'failed' | NULL (never attempted)
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sales') AND name = 'zoho_sync_error')
    ALTER TABLE dbo.sales ADD zoho_sync_error NVARCHAR(MAX) NULL;
GO
