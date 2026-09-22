/* =============================================================================
   PATCH: Link a specific serialized component unit to the specific assembly
   unit it was built into (per-unit component traceability)
   =============================================================================
   Run against a tenant that already has 09_module_inventory.sql (with
   inv_purchase_serial_units) and 10_module_manufacturing.sql applied.
   Idempotent — safe to re-run.

   Context: GET /manufacturing/assemblies/:id could only show an aggregate
   "totalUsed" per component across a whole assembly run, not which specific
   serialized component unit (e.g. a specific MCB) went into which specific
   finished unit (e.g. "PACE R Unit #1"). Needed for full customer-PO
   traceability: if a customer reports an issue, trace back to the exact
   serialized parts inside THEIR specific unit.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.inv_purchase_serial_units') AND name = 'is_used')
    ALTER TABLE dbo.inv_purchase_serial_units ADD is_used BIT NOT NULL DEFAULT 0;
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.mfg_assembly_items')
      AND name = 'consumed_lot_id' AND is_nullable = 0
)
    ALTER TABLE dbo.mfg_assembly_items ALTER COLUMN consumed_lot_id NVARCHAR(64) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.mfg_assembly_items') AND name = 'consumed_serial_unit_id')
    ALTER TABLE dbo.mfg_assembly_items ADD consumed_serial_unit_id NVARCHAR(64) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_mfg_ai_serial_unit')
    ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_serial_unit FOREIGN KEY (consumed_serial_unit_id) REFERENCES dbo.inv_purchase_serial_units(id);
GO
