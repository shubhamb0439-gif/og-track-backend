/* =============================================================================
   PATCH: Inventory — "Inward Outward" multi-item batches
   =============================================================================
   Run against a tenant that already has patch_24 (inv_stock_issues.customer_id)
   and patch_25 (inv_stock_returns) applied. Idempotent — safe to re-run.

   Context: Outward/Inward originally recorded one item per submission. A
   single real-world "send these 3 parts to this customer" action needs to
   create 3 real inv_stock_issues rows (FIFO consumption is still tracked
   per item, against that item's own lots), but they should visibly belong
   to one transaction in the history view — hence a nullable batch_id, not a
   redesign of the per-item rows themselves. NULL on every pre-existing row
   (an old single-item submission), real + shared across every line a new
   multi-item submission creates.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_stock_issues') AND name = 'batch_id')
    ALTER TABLE dbo.inv_stock_issues ADD batch_id NVARCHAR(64) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_stock_issues_batch')
    CREATE INDEX IX_inv_stock_issues_batch ON dbo.inv_stock_issues(batch_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_stock_returns') AND name = 'batch_id')
    ALTER TABLE dbo.inv_stock_returns ADD batch_id NVARCHAR(64) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_stock_returns_batch')
    CREATE INDEX IX_inv_stock_returns_batch ON dbo.inv_stock_returns(batch_id);
GO
