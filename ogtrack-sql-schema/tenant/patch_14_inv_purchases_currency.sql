/* =============================================================================
   PATCH: Inventory — currency on purchase orders
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql applied from
   before this column existed. Idempotent — safe to re-run.

   Context: inv_vendors already had its own currency (default 'INR'), but a
   purchase order had no currency of its own — a PO from a given vendor might
   still be placed in a different currency than that vendor's default, so it
   needs to be selectable per-PO, not just inherited silently.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_purchases') AND name = 'currency')
    ALTER TABLE dbo.inv_purchases ADD currency NVARCHAR(10) NOT NULL DEFAULT 'INR';
GO
