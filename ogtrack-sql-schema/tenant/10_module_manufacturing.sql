/* =============================================================================
   MODULE: MANUFACTURING  (v2 — Cajo-style per-unit traceability)
   =============================================================================
   Idempotent. Cross-module FKs deferred to end.
   ========================================================================== */

CREATE TABLE dbo.mfg_boms (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                NVARCHAR(200)  NOT NULL,
    product_item_id     NVARCHAR(64)   NOT NULL,
    notes               NVARCHAR(MAX)  NULL,
    created_by          NVARCHAR(64)   NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_mfg_boms_product UNIQUE (product_item_id)
);
GO

CREATE TABLE dbo.mfg_bom_lines (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    bom_id              NVARCHAR(64)   NOT NULL,
    component_item_id   NVARCHAR(64)   NOT NULL,
    quantity_per_unit   DECIMAL(14,2)  NOT NULL,

    CONSTRAINT CK_mfg_bom_lines_qty CHECK (quantity_per_unit > 0)
);
GO
CREATE INDEX IX_mfg_bom_lines_bom ON dbo.mfg_bom_lines(bom_id);
GO

CREATE TABLE dbo.mfg_assemblies (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_number     NVARCHAR(50)   NOT NULL,
    name                NVARCHAR(200)  NULL,
    bom_id              NVARCHAR(64)   NOT NULL,
    product_item_id     NVARCHAR(64)   NOT NULL,
    quantity_built      DECIMAL(14,2)  NOT NULL,
    unit_cost           DECIMAL(14,2)  NULL,
    total_cost          DECIMAL(14,2)  NULL,
    customer_po_number  NVARCHAR(50)   NULL,
    status              NVARCHAR(20)   NOT NULL DEFAULT 'completed',
    notes               NVARCHAR(MAX)  NULL,
    created_by          NVARCHAR(64)   NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_mfg_assemblies_status CHECK (status IN ('completed','reversed'))
);
GO
CREATE INDEX IX_mfg_assemblies_bom ON dbo.mfg_assemblies(bom_id);
GO
CREATE INDEX IX_mfg_assemblies_product ON dbo.mfg_assemblies(product_item_id);
GO

CREATE TABLE dbo.mfg_assembly_units (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_id         NVARCHAR(64)   NOT NULL,
    unit_number         INT            NOT NULL,
    serial_number       NVARCHAR(100)  NULL,
    output_lot_id       NVARCHAR(64)   NULL,
    sold                BIT            NOT NULL DEFAULT 0,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_mfg_assembly_units_serial ON dbo.mfg_assembly_units(serial_number) WHERE serial_number IS NOT NULL;
GO
CREATE INDEX IX_mfg_assembly_units_assembly ON dbo.mfg_assembly_units(assembly_id);
GO

CREATE TABLE dbo.mfg_assembly_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    assembly_id         NVARCHAR(64)   NOT NULL,
    assembly_unit_id    NVARCHAR(64)   NULL,
    component_item_id   NVARCHAR(64)   NOT NULL,
    consumed_lot_id     NVARCHAR(64)   NOT NULL,
    quantity            DECIMAL(14,2)  NOT NULL,
    consumed_unit_id    NVARCHAR(64)   NULL
);
GO
CREATE INDEX IX_mfg_assembly_items_assembly ON dbo.mfg_assembly_items(assembly_id);
GO
CREATE INDEX IX_mfg_assembly_items_unit ON dbo.mfg_assembly_items(assembly_unit_id);
GO
CREATE INDEX IX_mfg_assembly_items_component ON dbo.mfg_assembly_items(component_item_id);
GO

-- Same-module FKs
ALTER TABLE dbo.mfg_bom_lines ADD CONSTRAINT FK_mfg_bl_bom FOREIGN KEY (bom_id) REFERENCES dbo.mfg_boms(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.mfg_assemblies ADD CONSTRAINT FK_mfg_asm_bom FOREIGN KEY (bom_id) REFERENCES dbo.mfg_boms(id);
GO
ALTER TABLE dbo.mfg_assembly_units ADD CONSTRAINT FK_mfg_au_asm FOREIGN KEY (assembly_id) REFERENCES dbo.mfg_assemblies(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_asm FOREIGN KEY (assembly_id) REFERENCES dbo.mfg_assemblies(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_unit FOREIGN KEY (assembly_unit_id) REFERENCES dbo.mfg_assembly_units(id);
GO
ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_consumed_unit FOREIGN KEY (consumed_unit_id) REFERENCES dbo.mfg_assembly_units(id);
GO

-- Cross-module FKs (inv_items, inv_stock_lots)
ALTER TABLE dbo.mfg_boms ADD CONSTRAINT FK_mfg_boms_product FOREIGN KEY (product_item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.mfg_bom_lines ADD CONSTRAINT FK_mfg_bl_comp FOREIGN KEY (component_item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.mfg_assemblies ADD CONSTRAINT FK_mfg_asm_product FOREIGN KEY (product_item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.mfg_assembly_units ADD CONSTRAINT FK_mfg_au_lot FOREIGN KEY (output_lot_id) REFERENCES dbo.inv_stock_lots(id);
GO
ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_comp FOREIGN KEY (component_item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.mfg_assembly_items ADD CONSTRAINT FK_mfg_ai_lot FOREIGN KEY (consumed_lot_id) REFERENCES dbo.inv_stock_lots(id);
GO

-- User FKs
ALTER TABLE dbo.mfg_boms ADD CONSTRAINT FK_mfg_boms_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.mfg_assemblies ADD CONSTRAINT FK_mfg_asm_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO