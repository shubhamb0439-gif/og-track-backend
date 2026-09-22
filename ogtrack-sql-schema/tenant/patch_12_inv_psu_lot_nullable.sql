/* =============================================================================
   PATCH: Inventory — inv_purchase_serial_units.lot_id becomes nullable
   =============================================================================
   Run against a tenant that already applied patch_10 (or a base schema) with
   lot_id NOT NULL. Idempotent — safe to re-run.

   Context: POST /inventory/items/:id/serial-units lets someone manually add a
   serial for stock that predates the item being marked serial_tracked — there
   is no specific receiving lot to attribute that unit to, so lot_id must
   allow NULL for that path (rows created via /receive or /receive-lines still
   always set a real lot_id).
   ========================================================================== */

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.inv_purchase_serial_units')
      AND name = 'lot_id' AND is_nullable = 0
)
    ALTER TABLE dbo.inv_purchase_serial_units ALTER COLUMN lot_id NVARCHAR(64) NULL;
GO
