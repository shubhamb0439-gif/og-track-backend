/* =============================================================================
   PATCH: Inventory — serial units for purchased (not manufactured) items
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql applied from
   before this table existed. Idempotent — safe to re-run.

   Context: inv_items.serial_tracked already existed, but a serial-tracked item
   received via a regular Purchase Order (as opposed to built via
   Manufacturing, which already has mfg_assembly_units for this) had nowhere
   to record its individual units' serial numbers. This table mirrors
   mfg_assembly_units' pattern for purchased units instead.
   ========================================================================== */

IF OBJECT_ID('dbo.inv_purchase_serial_units') IS NULL
BEGIN
    CREATE TABLE dbo.inv_purchase_serial_units (
        id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
        item_id             NVARCHAR(64)   NOT NULL,
        lot_id              NVARCHAR(64)   NOT NULL,
        purchase_item_id    NVARCHAR(64)   NULL,
        unit_number         INT            NOT NULL,
        serial_number       NVARCHAR(100)  NULL,
        created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_psu_serial')
    CREATE UNIQUE INDEX IX_inv_psu_serial ON dbo.inv_purchase_serial_units(serial_number) WHERE serial_number IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_psu_item')
    CREATE INDEX IX_inv_psu_item ON dbo.inv_purchase_serial_units(item_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inv_psu_lot')
    CREATE INDEX IX_inv_psu_lot ON dbo.inv_purchase_serial_units(lot_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_psu_item')
    ALTER TABLE dbo.inv_purchase_serial_units ADD CONSTRAINT FK_inv_psu_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_psu_lot')
    ALTER TABLE dbo.inv_purchase_serial_units ADD CONSTRAINT FK_inv_psu_lot FOREIGN KEY (lot_id) REFERENCES dbo.inv_stock_lots(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_inv_psu_pi')
    ALTER TABLE dbo.inv_purchase_serial_units ADD CONSTRAINT FK_inv_psu_pi FOREIGN KEY (purchase_item_id) REFERENCES dbo.inv_purchase_items(id);
GO
