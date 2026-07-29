/* =============================================================================
   PATCH: Inventory — optional PO Number and Vendor on Purchases
   =============================================================================
   Run against an existing tenant DB that already has 09_module_inventory.sql
   applied. Idempotent — safe to re-run.

   Context: the Make Purchase modal in the reworked Inventory module treats
   both Vendor and PO Number as optional (e.g. an ad-hoc/walk-in buy with no
   PO and no named vendor on record), but inv_purchases had both as NOT NULL.
   ========================================================================== */

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.inv_purchases')
      AND name = 'po_number' AND is_nullable = 0
)
    ALTER TABLE dbo.inv_purchases ALTER COLUMN po_number NVARCHAR(50) NULL;
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.inv_purchases')
      AND name = 'vendor_id' AND is_nullable = 0
)
    ALTER TABLE dbo.inv_purchases ALTER COLUMN vendor_id NVARCHAR(64) NULL;
GO
