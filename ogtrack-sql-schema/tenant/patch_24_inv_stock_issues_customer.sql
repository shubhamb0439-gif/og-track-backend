/* =============================================================================
   PATCH: Inventory — "Inward Outward" manual issue-to-customer tracking
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql applied from
   before this column existed. Idempotent — safe to re-run.

   Context: inv_stock_issues already logs a generic stock deduction (e.g.
   internal consumption), but had no way to record WHO the stock went to.
   This adds an optional customer link, for the case where a replacement
   part is sent out manually (e.g. a failed part on a delivered machine)
   straight from inventory, bypassing the normal sales/dispatch flow, but
   still needs to reduce real stock and be attributable to a customer.

   customer_name is a snapshot (not just a join) so the issue history still
   reads correctly even if the customer record is later renamed or deleted.

   The FK to dbo.customers (a CRM-module table) is added only if that module
   is provisioned for this tenant — inventory can exist without CRM — same
   optional-cross-module-FK pattern used in 08_module_crm.sql for inv_items.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_stock_issues') AND name = 'customer_id')
    ALTER TABLE dbo.inv_stock_issues ADD customer_id NVARCHAR(64) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_stock_issues') AND name = 'customer_name')
    ALTER TABLE dbo.inv_stock_issues ADD customer_name NVARCHAR(200) NULL;
GO

IF OBJECT_ID('dbo.customers', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_stock_issues_customer')
    ALTER TABLE dbo.inv_stock_issues ADD CONSTRAINT FK_inv_stock_issues_customer FOREIGN KEY (customer_id) REFERENCES dbo.customers(id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_stock_issues_customer')
    CREATE INDEX IX_inv_stock_issues_customer ON dbo.inv_stock_issues(customer_id);
GO
