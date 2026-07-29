/* =============================================================================
   MODULE: SALES  (new — sales + deliveries)
   =============================================================================
   Idempotent. Cross-module FKs deferred to end.
   ========================================================================== */

CREATE TABLE dbo.sales (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    sale_number     NVARCHAR(50)   NOT NULL,
    customer_id     NVARCHAR(64)   NOT NULL,
    customer_po_id  NVARCHAR(64)   NULL,
    sale_date       DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    subtotal        DECIMAL(14,2)  NOT NULL DEFAULT 0,
    tax             DECIMAL(14,2)  NOT NULL DEFAULT 0,
    total           DECIMAL(14,2)  NOT NULL DEFAULT 0,
    is_delivered    BIT            NOT NULL DEFAULT 0,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(64)   NULL,
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_sales_sale_number ON dbo.sales(sale_number);
GO
CREATE INDEX IX_sales_customer ON dbo.sales(customer_id);
GO

CREATE TABLE dbo.sale_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    sale_id             NVARCHAR(64)   NOT NULL,
    assembly_unit_id    NVARCHAR(64)   NOT NULL,
    item_id             NVARCHAR(64)   NOT NULL,
    quantity            DECIMAL(14,2)  NOT NULL DEFAULT 1,
    unit_price          DECIMAL(14,2)  NOT NULL,
    line_total          DECIMAL(14,2)  NOT NULL,

    CONSTRAINT UQ_sale_items_unit UNIQUE (assembly_unit_id)
);
GO
CREATE INDEX IX_sale_items_sale ON dbo.sale_items(sale_id);
GO
CREATE INDEX IX_sale_items_item ON dbo.sale_items(item_id);
GO

CREATE TABLE dbo.deliveries (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    delivery_number     NVARCHAR(50)   NOT NULL,
    sale_id             NVARCHAR(64)   NOT NULL,
    delivery_address    NVARCHAR(500)  NULL,
    delivery_location   NVARCHAR(200)  NULL,
    scheduled_date      DATE           NULL,
    delivered_date      DATETIME2      NULL,
    delivered           BIT            NOT NULL DEFAULT 0,
    notes               NVARCHAR(MAX)  NULL,
    created_by          NVARCHAR(64)   NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by          NVARCHAR(64)   NULL,
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT UQ_deliveries_sale UNIQUE (sale_id)
);
GO
CREATE UNIQUE INDEX IX_deliveries_delivery_number ON dbo.deliveries(delivery_number);
GO

CREATE TABLE dbo.delivery_items (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    delivery_id     NVARCHAR(64)   NOT NULL,
    sale_item_id    NVARCHAR(64)   NOT NULL
);
GO
CREATE INDEX IX_delivery_items_delivery ON dbo.delivery_items(delivery_id);
GO

-- Same-module FKs
ALTER TABLE dbo.sale_items ADD CONSTRAINT FK_sale_items_sale FOREIGN KEY (sale_id) REFERENCES dbo.sales(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.deliveries ADD CONSTRAINT FK_deliveries_sale FOREIGN KEY (sale_id) REFERENCES dbo.sales(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.delivery_items ADD CONSTRAINT FK_di_delivery FOREIGN KEY (delivery_id) REFERENCES dbo.deliveries(id) ON DELETE CASCADE;
GO
ALTER TABLE dbo.delivery_items ADD CONSTRAINT FK_di_sale_item FOREIGN KEY (sale_item_id) REFERENCES dbo.sale_items(id);
GO

-- Cross-module FKs
ALTER TABLE dbo.sales ADD CONSTRAINT FK_sales_customer FOREIGN KEY (customer_id) REFERENCES dbo.customers(id);
GO
ALTER TABLE dbo.sales ADD CONSTRAINT FK_sales_po FOREIGN KEY (customer_po_id) REFERENCES dbo.customer_purchase_orders(id);
GO
ALTER TABLE dbo.sale_items ADD CONSTRAINT FK_sale_items_unit FOREIGN KEY (assembly_unit_id) REFERENCES dbo.mfg_assembly_units(id);
GO
ALTER TABLE dbo.sale_items ADD CONSTRAINT FK_sale_items_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO

-- User FKs
ALTER TABLE dbo.sales ADD CONSTRAINT FK_sales_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.deliveries ADD CONSTRAINT FK_deliveries_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO