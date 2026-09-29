/* =============================================================================
   PATCH: Inventory — invoice number per receipt (stock lot)
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql applied from
   before this column existed. Idempotent — safe to re-run.

   Context: a purchase can be received in several partial deliveries, each
   with its own vendor invoice. inv_purchases.invoice_number only holds ONE
   invoice for the whole PO, but every positive receipt via /receive or
   /receive-lines already creates its own inv_stock_lots row (one per line
   per receipt) — so the invoice for that specific delivery lives on the lot.
   NULL for lots that predate this column, and for non-purchase lots
   (opening_stock / manual / assembly).
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_stock_lots') AND name = 'invoice_number')
    ALTER TABLE dbo.inv_stock_lots ADD invoice_number NVARCHAR(100) NULL;
GO
