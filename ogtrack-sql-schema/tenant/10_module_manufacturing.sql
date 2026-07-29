/* =============================================================================
   MODULE: MANUFACTURING  (v2 — Cajo-style per-unit traceability)
   =============================================================================
   Key change from v1: an assembly no longer just produces "N units of the
   product item". It now produces N INDIVIDUALLY TRACKED units (mfg_assembly_units),
   each with its own serial number. Every component consumed on that unit is
   linked to the specific unit via mfg_assembly_items, giving full per-unit
   component traceability — same design as Cajo's system.
   ========================================================================== */

CREATE TABLE dbo.mfg_boms (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                NVARCHAR(200)  NOT NULL,
    product_item_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    notes               NVARCHAR(MAX)  NULL,
    created_by          NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_mfg_boms_product UNIQUE (product_item_id)
);
GO

CREATE TABLE dbo.mfg_bom_lines (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    bom_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_boms(id) ON DELETE CASCADE,
    component_item_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity_per_unit   DECIMAL(14,2)  NOT NULL,

    CONSTRAINT CK_mfg_bom_lines_qty CHECK (quantity_per_unit > 0)
);
GO
CREATE INDEX IX_mfg_bom_lines_bom ON dbo.mfg_bom_lines(bom_id);
GO

CREATE TABLE dbo.mfg_assemblies (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_number     NVARCHAR(50)   NOT NULL,             -- e.g. 'ASM-0001'
    name                NVARCHAR(200)  NULL,
    bom_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_boms(id),
    product_item_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity_built      DECIMAL(14,2)  NOT NULL,
    unit_cost           DECIMAL(14,2)  NULL,                 -- computed cost per built unit
    total_cost          DECIMAL(14,2)  NULL,                 -- unit_cost * quantity_built
    customer_po_number  NVARCHAR(50)   NULL,                 -- optional link to a customer PO
    status              NVARCHAR(20)   NOT NULL DEFAULT 'completed',
    notes               NVARCHAR(MAX)  NULL,
    created_by          NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_mfg_assemblies_status CHECK (status IN ('completed','reversed'))
);
GO
CREATE INDEX IX_mfg_assemblies_bom ON dbo.mfg_assemblies(bom_id);
GO
CREATE INDEX IX_mfg_assemblies_product ON dbo.mfg_assemblies(product_item_id);
GO

/* Per-unit tracking: every unit produced by an assembly is its own row.
   For a "5 lasers built" run there will be 5 rows here, each with its own
   serial number, each linkable to its specific component instances below. */
CREATE TABLE dbo.mfg_assembly_units (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_assemblies(id) ON DELETE CASCADE,
    unit_number         INT            NOT NULL,             -- 1..quantity_built
    serial_number       NVARCHAR(100)  NULL,                 -- unique per tenant when set
    -- The lot this specific finished unit belongs to (a build creates exactly
    -- one lot per assembly, and every unit produced by that build points at it).
    output_lot_id       NVARCHAR(64)   NULL REFERENCES dbo.inv_stock_lots(id),
    -- Set once the unit is sold. Not FK'd to sales here because sales lives in
    -- module 11; the FK is enforced from the other side (sale_items -> unit_id).
    sold                BIT            NOT NULL DEFAULT 0,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_mfg_assembly_units_serial ON dbo.mfg_assembly_units(serial_number) WHERE serial_number IS NOT NULL;
GO
CREATE INDEX IX_mfg_assembly_units_assembly ON dbo.mfg_assembly_units(assembly_id);
GO

/* Per-component-per-unit traceability: which SPECIFIC lot(s) of a component
   went into which SPECIFIC finished unit. This is what makes Cajo's story
   ("serial number 12345 of laser X — what exact filter batch did it use?") work.
   A single assembly line may split across multiple lots if one lot was too
   small to cover a build. */
CREATE TABLE dbo.mfg_assembly_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_assemblies(id) ON DELETE CASCADE,
    assembly_unit_id    NVARCHAR(64)   NULL REFERENCES dbo.mfg_assembly_units(id),
    component_item_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    -- The specific stock lot this consumption drew from.
    consumed_lot_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_stock_lots(id),
    quantity            DECIMAL(14,2)  NOT NULL,
    -- If the component itself is serial-tracked (rare — e.g. a sub-assembly
    -- whose OWN serial matters), the specific unit consumed here.
    consumed_unit_id    NVARCHAR(64)   NULL REFERENCES dbo.mfg_assembly_units(id)
);
GO
CREATE INDEX IX_mfg_assembly_items_assembly ON dbo.mfg_assembly_items(assembly_id);
GO
CREATE INDEX IX_mfg_assembly_items_unit ON dbo.mfg_assembly_items(assembly_unit_id);
GO
CREATE INDEX IX_mfg_assembly_items_component ON dbo.mfg_assembly_items(component_item_id);
GO