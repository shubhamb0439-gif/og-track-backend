/* =============================================================================
   TENANT DATABASE — Part 10: MANUFACTURING (Phase 3 of the Inventory+CRM addon)
   Provisioned when the 'manufacturing' module is enabled.

   DEPENDS ON THE INVENTORY MODULE (dbo.inv_items) — provisioning.js forces
   09_module_inventory.sql to run first if it hasn't already, specifically
   because of this dependency.

   Covers: BOM (Bill of Materials = the recipe) and Assembly (the act of
   building, which consumes components and creates product).
   ============================================================================= */

/* ---------------------------------------------------------------------------
   mfg_boms — one row per recipe. A product can have more than one BOM (e.g.
   different versions), and — per the nested-BOM pattern in real manufacturing
   — a BOM's product can itself be used as a component inside ANOTHER BOM
   (e.g. a "wheel" BOM produces a wheel, which is then a component line in
   the "bicycle" BOM). Nothing enforces that here; it falls out naturally
   from product_item_id and component_item_id both just pointing at
   dbo.inv_items.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.mfg_boms (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                NVARCHAR(200)  NOT NULL,
    product_item_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    notes               NVARCHAR(MAX)  NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_mfg_boms_product ON dbo.mfg_boms(product_item_id);
GO

/* ---------------------------------------------------------------------------
   mfg_bom_lines — the recipe's ingredient list: "N units of this component
   per 1 unit of the product".
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.mfg_bom_lines (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    bom_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_boms(id),
    component_item_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity_per_unit   DECIMAL(14,2)  NOT NULL
);
GO
CREATE INDEX IX_mfg_bom_lines_bom ON dbo.mfg_bom_lines(bom_id);
GO

/* ---------------------------------------------------------------------------
   mfg_assemblies — one row per build event: "we built N units of this
   product, following this BOM, on this date".
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.mfg_assemblies (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    bom_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_boms(id),
    product_item_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),  -- denormalized for convenience
    quantity_built       DECIMAL(14,2)  NOT NULL,
    assembly_date       DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    notes               NVARCHAR(500)  NULL,
    created_by          NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_mfg_assemblies_bom ON dbo.mfg_assemblies(bom_id);
GO
CREATE INDEX IX_mfg_assemblies_product ON dbo.mfg_assemblies(product_item_id);
GO

/* ---------------------------------------------------------------------------
   mfg_assembly_lines — exactly how much of each component this specific
   assembly run actually consumed (quantity_per_unit * quantity_built at the
   time it ran) — kept as its own audit trail rather than recomputed later,
   in case the BOM itself changes afterward.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.mfg_assembly_lines (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.mfg_assemblies(id),
    component_item_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity_consumed   DECIMAL(14,2)  NOT NULL
);
GO
CREATE INDEX IX_mfg_assembly_lines_assembly ON dbo.mfg_assembly_lines(assembly_id);
GO
