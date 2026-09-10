/* =============================================================================
   PATCH: Sitara — purchase orders link to weavers (not vendors), + expenses
   =============================================================================
   Run against a tenant that already has 17_module_sitara.sql applied from
   before this logic change. Idempotent — safe to re-run.

   Context: stock purchases are made from weavers; vendors are for other
   business expenses (electricity, rent, etc.) tracked in the new
   sitara_expenses table. This patch only runs the rename/table-create when
   the old shape is still present, so it's a no-op on any tenant provisioned
   after 17_module_sitara.sql was updated to the new shape directly.
   ========================================================================== */

-- Rename sitara_purchase_orders.vendor_id -> weaver_id, re-pointing the FK.
-- Guarded on vendor_id still existing (skip entirely once already migrated).
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.sitara_purchase_orders')
      AND name = 'vendor_id'
)
BEGIN
    IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_sitara_po_vendor')
        ALTER TABLE dbo.sitara_purchase_orders DROP CONSTRAINT FK_sitara_po_vendor;

    EXEC sp_rename 'dbo.sitara_purchase_orders.vendor_id', 'weaver_id', 'COLUMN';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_sitara_po_weaver')
    ALTER TABLE dbo.sitara_purchase_orders ADD CONSTRAINT FK_sitara_po_weaver FOREIGN KEY (weaver_id) REFERENCES dbo.sitara_weavers(id);
GO

IF OBJECT_ID('dbo.sitara_expenses') IS NULL
BEGIN
    CREATE TABLE dbo.sitara_expenses (
        id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
        vendor_id       NVARCHAR(64)   NOT NULL,
        category        NVARCHAR(100)  NOT NULL,
        description     NVARCHAR(500)  NULL,
        amount          DECIMAL(14,2)  NOT NULL,
        expense_date    DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
        created_by      NVARCHAR(64)   NULL,
        created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_sitara_expenses_vendor')
    CREATE INDEX IX_sitara_expenses_vendor ON dbo.sitara_expenses(vendor_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_sitara_expenses_date')
    CREATE INDEX IX_sitara_expenses_date ON dbo.sitara_expenses(expense_date);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_sitara_expenses_vendor')
    ALTER TABLE dbo.sitara_expenses ADD CONSTRAINT FK_sitara_expenses_vendor FOREIGN KEY (vendor_id) REFERENCES dbo.sitara_vendors(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_sitara_expenses_user')
    ALTER TABLE dbo.sitara_expenses ADD CONSTRAINT FK_sitara_expenses_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
