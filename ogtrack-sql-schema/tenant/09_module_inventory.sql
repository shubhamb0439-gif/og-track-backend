/* =============================================================================
   TENANT DATABASE — Part 9: INVENTORY (Phase 2 of the Inventory+CRM addon)
   Provisioned when the 'inventory' module is enabled.

   Covers: Vendors, Items (Part/Component/Product), Purchases + receiving,
   and stock math. Manufacturing (BOM/Assembly) is Phase 3 — not here yet.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   inv_vendors — external suppliers you buy from. Money flows OUT to them.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.inv_vendors (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    email           NVARCHAR(200)  NULL,
    phone           NVARCHAR(50)   NULL,
    address         NVARCHAR(500)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

/* ---------------------------------------------------------------------------
   inv_items — the master inventory catalog: Parts, Components, Products.
   `stock` is maintained by the app (purchase receipts add to it, manual
   adjustments correct it) — there's no "type over the stock count" field,
   matching how the real Cajo ERP behaves.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.inv_items (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    item_code       NVARCHAR(100)  NULL,                    -- SKU / part number
    item_group      NVARCHAR(20)   NOT NULL DEFAULT 'part',  -- part | component | product
    item_class      NVARCHAR(5)    NULL,                     -- A | B | C (ABC priority tier)
    unit            NVARCHAR(30)   NULL DEFAULT 'pcs',

    stock           DECIMAL(14,2)  NOT NULL DEFAULT 0,       -- current on-hand (maintained, not typed in)
    sold            DECIMAL(14,2)  NOT NULL DEFAULT 0,       -- cumulative units sold (Phase 3+/manual for now)
    avg_cost        DECIMAL(14,2)  NULL,                     -- recomputed from received purchase lines
    avg_lead_time_days INT         NULL,

    min_stock       DECIMAL(14,2)  NULL,
    max_stock       DECIMAL(14,2)  NULL,
    reorder_point   DECIMAL(14,2)  NULL,

    notes           NVARCHAR(MAX)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_inv_items_group CHECK (item_group IN ('part','component','product'))
);
GO
CREATE INDEX IX_inv_items_group ON dbo.inv_items(item_group);
GO

/* ---------------------------------------------------------------------------
   inv_stock_adjustments — manual corrections (physical counts, damage,
   write-offs). Every change to dbo.inv_items.stock that ISN'T a purchase
   receipt goes through here, so there's always an audit trail for "why did
   the stock number change".
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.inv_stock_adjustments (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    item_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    delta           DECIMAL(14,2)  NOT NULL,                 -- can be negative
    reason          NVARCHAR(500)  NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_inv_stock_adjustments_item ON dbo.inv_stock_adjustments(item_id);
GO

/* ---------------------------------------------------------------------------
   inv_purchases — one row per purchase order placed with a vendor.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.inv_purchases (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    po_number       NVARCHAR(50)   NOT NULL,
    vendor_id       NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_vendors(id),
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',  -- pending | partial | received | cancelled
    order_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    expected_date   DATE           NULL,
    received_date   DATE           NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_inv_purchases_status CHECK (status IN ('pending','partial','received','cancelled'))
);
GO
CREATE INDEX IX_inv_purchases_vendor ON dbo.inv_purchases(vendor_id);
GO
CREATE INDEX IX_inv_purchases_status ON dbo.inv_purchases(status);
GO

/* ---------------------------------------------------------------------------
   inv_purchase_items — line items on a purchase order.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.inv_purchase_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    purchase_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_purchases(id),
    item_id              NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity_ordered     DECIMAL(14,2)  NOT NULL,
    quantity_received    DECIMAL(14,2)  NOT NULL DEFAULT 0,
    unit_cost            DECIMAL(14,2)  NOT NULL DEFAULT 0
);
GO
CREATE INDEX IX_inv_purchase_items_purchase ON dbo.inv_purchase_items(purchase_id);
GO
CREATE INDEX IX_inv_purchase_items_item ON dbo.inv_purchase_items(item_id);
GO
