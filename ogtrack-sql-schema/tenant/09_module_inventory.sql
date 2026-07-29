/* =============================================================================
   MODULE: INVENTORY  (v2 — vendors + items + purchases + lot tracking)
   =============================================================================
   Idempotent. Cross-module FKs deferred to end of file, same pattern as
   module 08.
   ========================================================================== */

CREATE TABLE dbo.inv_vendors (
    id                    NVARCHAR(64)   NOT NULL PRIMARY KEY,
    vendor_code           NVARCHAR(50)   NULL,
    name                  NVARCHAR(200)  NOT NULL,
    legal_name            NVARCHAR(200)  NULL,
    vendor_group          NVARCHAR(100)  NULL,
    contact_name          NVARCHAR(200)  NULL,
    email                 NVARCHAR(200)  NULL,
    phone                 NVARCHAR(50)   NULL,
    address               NVARCHAR(500)  NULL,
    currency              NVARCHAR(10)   NOT NULL DEFAULT 'INR',
    rating_price          DECIMAL(3,2)   NULL,
    rating_quality        DECIMAL(3,2)   NULL,
    rating_lead_time      DECIMAL(3,2)   NULL,
    notes                 NVARCHAR(MAX)  NULL,
    created_by            NVARCHAR(64)   NULL,
    created_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_inv_vendors_rating_price   CHECK (rating_price   IS NULL OR (rating_price   BETWEEN 0 AND 5)),
    CONSTRAINT CK_inv_vendors_rating_quality CHECK (rating_quality IS NULL OR (rating_quality BETWEEN 0 AND 5)),
    CONSTRAINT CK_inv_vendors_rating_lead    CHECK (rating_lead_time IS NULL OR (rating_lead_time BETWEEN 0 AND 5))
);
GO
CREATE UNIQUE INDEX IX_inv_vendors_code ON dbo.inv_vendors(vendor_code) WHERE vendor_code IS NOT NULL;
GO

CREATE TABLE dbo.inv_items (
    id                    NVARCHAR(64)   NOT NULL PRIMARY KEY,
    item_code             NVARCHAR(50)   NULL,
    name                  NVARCHAR(200)  NOT NULL,
    display_name          NVARCHAR(200)  NULL,
    unit                  NVARCHAR(20)   NOT NULL DEFAULT 'pcs',
    item_group            NVARCHAR(100)  NULL,
    item_class            NVARCHAR(100)  NULL,
    stock                 DECIMAL(14,2)  NOT NULL DEFAULT 0,
    stock_sold            DECIMAL(14,2)  NOT NULL DEFAULT 0,
    stock_min             DECIMAL(14,2)  NOT NULL DEFAULT 0,
    stock_max             DECIMAL(14,2)  NOT NULL DEFAULT 0,
    stock_reorder         DECIMAL(14,2)  NOT NULL DEFAULT 0,
    avg_cost              DECIMAL(14,2)  NULL,
    cost_min              DECIMAL(14,2)  NULL,
    cost_max              DECIMAL(14,2)  NULL,
    serial_tracked        BIT            NOT NULL DEFAULT 0,
    notes                 NVARCHAR(MAX)  NULL,
    created_by            NVARCHAR(64)   NULL,
    created_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_inv_items_code ON dbo.inv_items(item_code) WHERE item_code IS NOT NULL;
GO
CREATE INDEX IX_inv_items_group ON dbo.inv_items(item_group);
GO

CREATE TABLE dbo.inv_stock_adjustments (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    item_id         NVARCHAR(64)   NOT NULL,
    delta           DECIMAL(14,2)  NOT NULL,
    reason          NVARCHAR(500)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_inv_stock_adjustments_item ON dbo.inv_stock_adjustments(item_id);
GO

CREATE TABLE dbo.inv_purchases (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    po_number       NVARCHAR(50)   NOT NULL,
    vendor_id       NVARCHAR(64)   NOT NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',
    order_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    expected_date   DATE           NULL,
    received_date   DATE           NULL,
    invoice_number  NVARCHAR(100)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_inv_purchases_status CHECK (status IN ('pending','partial','received','cancelled'))
);
GO

CREATE TABLE dbo.inv_purchase_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    purchase_id         NVARCHAR(64)   NOT NULL,
    item_id             NVARCHAR(64)   NOT NULL,
    vendor_item_code    NVARCHAR(100)  NULL,
    quantity_ordered    DECIMAL(14,2)  NOT NULL,
    quantity_received   DECIMAL(14,2)  NOT NULL DEFAULT 0,
    unit_cost           DECIMAL(14,2)  NOT NULL DEFAULT 0,
    freight_cost        DECIMAL(14,2)  NOT NULL DEFAULT 0,
    import_charges      DECIMAL(14,2)  NOT NULL DEFAULT 0,
    lead_time_days      INT            NULL
);
GO
CREATE INDEX IX_inv_purchase_items_purchase ON dbo.inv_purchase_items(purchase_id);
GO
CREATE INDEX IX_inv_purchase_items_item ON dbo.inv_purchase_items(item_id);
GO

CREATE TABLE dbo.inv_stock_lots (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    item_id             NVARCHAR(64)   NOT NULL,
    lot_ref             NVARCHAR(100)  NULL,
    vendor_id           NVARCHAR(64)   NULL,
    purchase_item_id    NVARCHAR(64)   NULL,
    quantity_received   DECIMAL(14,2)  NOT NULL,
    quantity_remaining  DECIMAL(14,2)  NOT NULL,
    unit_cost           DECIMAL(14,2)  NOT NULL,
    received_date       DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    source              NVARCHAR(20)   NOT NULL DEFAULT 'purchase',
    notes               NVARCHAR(500)  NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_inv_stock_lots_source CHECK (source IN ('purchase','opening_stock','manual','import','assembly'))
);
GO
CREATE INDEX IX_inv_stock_lots_item ON dbo.inv_stock_lots(item_id);
GO
CREATE INDEX IX_inv_stock_lots_received_date ON dbo.inv_stock_lots(received_date);
GO

CREATE TABLE dbo.inv_stock_issues (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    item_id         NVARCHAR(64)   NOT NULL,
    quantity        DECIMAL(14,2)  NOT NULL,
    issue_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    details         NVARCHAR(500)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_inv_stock_issues_item ON dbo.inv_stock_issues(item_id);
GO

CREATE TABLE dbo.inv_stock_issue_lots (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    issue_id        NVARCHAR(64)   NOT NULL,
    lot_id          NVARCHAR(64)   NOT NULL,
    quantity        DECIMAL(14,2)  NOT NULL
);
GO
CREATE INDEX IX_inv_stock_issue_lots_issue ON dbo.inv_stock_issue_lots(issue_id);
GO

-- FKs added at end for order-safety
ALTER TABLE dbo.inv_stock_adjustments ADD CONSTRAINT FK_inv_adj_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.inv_stock_adjustments ADD CONSTRAINT FK_inv_adj_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.inv_purchases ADD CONSTRAINT FK_inv_purchases_vendor FOREIGN KEY (vendor_id) REFERENCES dbo.inv_vendors(id);
GO
ALTER TABLE dbo.inv_purchases ADD CONSTRAINT FK_inv_purchases_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.inv_purchase_items ADD CONSTRAINT FK_inv_pi_purchase FOREIGN KEY (purchase_id) REFERENCES dbo.inv_purchases(id);
GO
ALTER TABLE dbo.inv_purchase_items ADD CONSTRAINT FK_inv_pi_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.inv_stock_lots ADD CONSTRAINT FK_inv_lots_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.inv_stock_lots ADD CONSTRAINT FK_inv_lots_vendor FOREIGN KEY (vendor_id) REFERENCES dbo.inv_vendors(id);
GO
ALTER TABLE dbo.inv_stock_lots ADD CONSTRAINT FK_inv_lots_pi FOREIGN KEY (purchase_item_id) REFERENCES dbo.inv_purchase_items(id);
GO
ALTER TABLE dbo.inv_stock_issues ADD CONSTRAINT FK_inv_issues_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO
ALTER TABLE dbo.inv_stock_issues ADD CONSTRAINT FK_inv_issues_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.inv_stock_issue_lots ADD CONSTRAINT FK_inv_il_issue FOREIGN KEY (issue_id) REFERENCES dbo.inv_stock_issues(id);
GO
ALTER TABLE dbo.inv_stock_issue_lots ADD CONSTRAINT FK_inv_il_lot FOREIGN KEY (lot_id) REFERENCES dbo.inv_stock_lots(id);
GO
ALTER TABLE dbo.inv_vendors ADD CONSTRAINT FK_inv_vendors_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.inv_items ADD CONSTRAINT FK_inv_items_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO

-- Back-add the CRM cross-module FK if that module was created first
IF OBJECT_ID('dbo.customer_purchase_order_items', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_customer_po_items_item')
    ALTER TABLE dbo.customer_purchase_order_items ADD CONSTRAINT FK_customer_po_items_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO