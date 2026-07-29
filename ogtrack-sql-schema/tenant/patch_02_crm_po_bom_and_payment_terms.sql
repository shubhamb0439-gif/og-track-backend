/* =============================================================================
   PATCH: CRM Purchase Orders — BOM-based line items + payment terms
   =============================================================================
   Run against an existing tenant DB that already has 08_module_crm.sql applied.
   Idempotent — safe to re-run.

   Context: Purchase Orders previously only supported ordering existing
   inventory items. The Sales & CRM rework changes this so a customer PO line
   orders "N units of assembly built from BOM X" instead — matching the
   Purchase Order → Sales → Delivery workflow (PO specifies what to build,
   Sales bills the manufactured units, Delivery ships them by serial).

   customer_purchase_order_items gets two new nullable columns:
     - bom_id             the BOM to build against (NULL for old item-based rows)
     - assembly_quantity  quantity of assemblies to build (NULL for old rows)
   item_id/quantity remain but become optional (a line is either item-based OR
   BOM-based, enforced by a CHECK constraint) so existing item-based POs and
   their line data are left completely intact.
   ========================================================================== */

IF COL_LENGTH('dbo.customer_purchase_order_items', 'bom_id') IS NULL
    ALTER TABLE dbo.customer_purchase_order_items ADD bom_id NVARCHAR(64) NULL;
GO
IF COL_LENGTH('dbo.customer_purchase_order_items', 'assembly_quantity') IS NULL
    ALTER TABLE dbo.customer_purchase_order_items ADD assembly_quantity DECIMAL(14,2) NULL;
GO

-- item_id was NOT NULL originally; relax it since a line can now be BOM-based instead.
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.customer_purchase_order_items')
      AND name = 'item_id' AND is_nullable = 0
)
    ALTER TABLE dbo.customer_purchase_order_items ALTER COLUMN item_id NVARCHAR(64) NULL;
GO
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.customer_purchase_order_items')
      AND name = 'quantity' AND is_nullable = 0
)
    ALTER TABLE dbo.customer_purchase_order_items ALTER COLUMN quantity DECIMAL(14,2) NULL;
GO

-- Exactly one of (item_id) or (bom_id) must be set per line.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints WHERE name = 'CK_customer_po_items_kind'
)
    ALTER TABLE dbo.customer_purchase_order_items
    ADD CONSTRAINT CK_customer_po_items_kind CHECK (
        (item_id IS NOT NULL AND bom_id IS NULL AND quantity IS NOT NULL)
        OR
        (bom_id IS NOT NULL AND item_id IS NULL AND assembly_quantity IS NOT NULL)
    );
GO

IF OBJECT_ID('dbo.mfg_boms', 'U') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_customer_po_items_bom')
    ALTER TABLE dbo.customer_purchase_order_items
    ADD CONSTRAINT FK_customer_po_items_bom FOREIGN KEY (bom_id) REFERENCES dbo.mfg_boms(id);
GO

-- Payment terms, shown on the PO form/detail per the new design.
IF COL_LENGTH('dbo.customer_purchase_orders', 'payment_terms') IS NULL
    ALTER TABLE dbo.customer_purchase_orders ADD payment_terms NVARCHAR(200) NULL;
GO
