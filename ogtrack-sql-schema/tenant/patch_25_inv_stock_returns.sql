/* =============================================================================
   PATCH: Inventory — "Inward Outward": separate Inward (customer return) flow
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql + patch_24
   applied. Idempotent — safe to re-run.

   Context: the "Inward Outward" feature (patch_24) covers Outward only —
   stock LEAVING for a customer (inv_stock_issues, customer_id added there).
   This patch adds the separate Inward counterpart — stock coming BACK from a
   customer (a returned/replaced part), which ADDS to real stock instead of
   consuming it. Deliberately a separate table, not a reuse of
   inv_stock_issues with a negative quantity, since Inward and Outward are
   two distinct modals/forms with their own history views, per the actual
   request.

   An Inward return creates a real new stock lot (same mechanism as any other
   stock addition — see createLot in utils/stockLots.js) so the returned
   quantity is immediately available again like any other stock, FIFO-
   consumable by a future Outward/sale/assembly — not a separate pool.
   ========================================================================== */

-- 'customer_return' is a new, distinct source value from 'manual' so stock
-- lot history can tell "a customer sent this back" apart from a generic
-- manual stock correction.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = 'CK_inv_stock_lots_source'
      AND definition LIKE '%customer_return%'
)
BEGIN
    ALTER TABLE dbo.inv_stock_lots DROP CONSTRAINT CK_inv_stock_lots_source;
    ALTER TABLE dbo.inv_stock_lots ADD CONSTRAINT CK_inv_stock_lots_source
        CHECK (source IN ('purchase','opening_stock','manual','import','assembly','customer_return'));
END
GO

IF OBJECT_ID('dbo.inv_stock_returns', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inv_stock_returns (
        id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
        item_id         NVARCHAR(64)   NOT NULL,
        lot_id          NVARCHAR(64)   NULL,
        quantity        DECIMAL(14,2)  NOT NULL,
        return_date     DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
        details         NVARCHAR(500)  NULL,
        customer_id     NVARCHAR(64)   NULL,
        -- Snapshot, not just a join — same reasoning as inv_stock_issues.customer_name
        -- (patch_24): history stays readable even if the customer is later renamed.
        customer_name   NVARCHAR(200)  NULL,
        created_by      NVARCHAR(64)   NULL,
        created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_stock_returns_item')
    CREATE INDEX IX_inv_stock_returns_item ON dbo.inv_stock_returns(item_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_stock_returns_customer')
    CREATE INDEX IX_inv_stock_returns_customer ON dbo.inv_stock_returns(customer_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_stock_returns_item')
    ALTER TABLE dbo.inv_stock_returns ADD CONSTRAINT FK_inv_stock_returns_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_stock_returns_lot')
    ALTER TABLE dbo.inv_stock_returns ADD CONSTRAINT FK_inv_stock_returns_lot FOREIGN KEY (lot_id) REFERENCES dbo.inv_stock_lots(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_stock_returns_user')
    ALTER TABLE dbo.inv_stock_returns ADD CONSTRAINT FK_inv_stock_returns_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO

-- Same optional-cross-module-FK pattern as patch_24 — inventory can exist
-- without CRM.
IF OBJECT_ID('dbo.customers', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_stock_returns_customer')
    ALTER TABLE dbo.inv_stock_returns ADD CONSTRAINT FK_inv_stock_returns_customer FOREIGN KEY (customer_id) REFERENCES dbo.customers(id);
GO
