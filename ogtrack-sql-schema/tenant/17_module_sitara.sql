/* =============================================================================
   MODULE: SITARA BESPOKE  (dashboard, people, stocks, business)
   =============================================================================
   A dedicated bundle for a BigCommerce-fed tenant — weavers/vendors/customers,
   saree inventory + weaver-linked purchases (stock is bought FROM weavers,
   not vendors), and a "Business" area covering orders synced from BigCommerce
   (source = 'bigcommerce') alongside manually-entered orders (source =
   'manual', e.g. a GPay/DM sale that never went through checkout), Razorpay
   reconciliation, and vendor-linked expenses (electricity, rent, etc. — i.e.
   what vendors are actually for here).
   Deliberately its own tables, not an extension of the generic
   crm/inventory/sales modules — Sitara's domain doesn't fit those, and
   gating it behind them would drag in unrelated module baggage.

   Idempotent-by-construction (fresh CREATEs only — this script only ever
   runs once per tenant, same as every other NN_module_*.sql file). FKs
   deferred to end of file, same pattern as modules 08/09.
   ========================================================================== */

CREATE TABLE dbo.sitara_weavers (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    contact_name    NVARCHAR(200)  NULL,
    phone           NVARCHAR(50)   NULL,
    email           NVARCHAR(200)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE dbo.sitara_vendors (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    contact_name    NVARCHAR(200)  NULL,
    phone           NVARCHAR(50)   NULL,
    email           NVARCHAR(200)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE dbo.sitara_customers (
    id                      NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                    NVARCHAR(200)  NOT NULL,
    phone                   NVARCHAR(50)   NULL,
    email                   NVARCHAR(200)  NULL,
    source                  NVARCHAR(20)   NOT NULL DEFAULT 'manual',
    bigcommerce_customer_id NVARCHAR(64)   NULL,
    notes                   NVARCHAR(MAX)  NULL,
    created_by              NVARCHAR(64)   NULL,
    created_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_sitara_customers_source CHECK (source IN ('bigcommerce','whatsapp','instagram','manual'))
);
GO
CREATE UNIQUE INDEX IX_sitara_customers_bc_id ON dbo.sitara_customers(bigcommerce_customer_id) WHERE bigcommerce_customer_id IS NOT NULL;
GO

CREATE TABLE dbo.sitara_products (
    id                      NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                    NVARCHAR(200)  NOT NULL,
    sku                     NVARCHAR(100)  NULL,
    vendor_id               NVARCHAR(64)   NULL,
    weaver_id               NVARCHAR(64)   NULL,
    stock                   DECIMAL(14,2)  NOT NULL DEFAULT 0,
    unit                    NVARCHAR(20)   NOT NULL DEFAULT 'pcs',
    -- Reserved for future BigCommerce catalog sync — deliberately unused by
    -- any code in this phase; products stay manually entered for now.
    bigcommerce_product_id  NVARCHAR(64)   NULL,
    notes                   NVARCHAR(MAX)  NULL,
    created_by              NVARCHAR(64)   NULL,
    created_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_sitara_products_bc_id ON dbo.sitara_products(bigcommerce_product_id) WHERE bigcommerce_product_id IS NOT NULL;
GO
CREATE INDEX IX_sitara_products_vendor ON dbo.sitara_products(vendor_id);
GO
CREATE INDEX IX_sitara_products_weaver ON dbo.sitara_products(weaver_id);
GO

CREATE TABLE dbo.sitara_purchase_orders (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    po_number       NVARCHAR(50)   NOT NULL,
    -- Stock purchases are made from weavers, not vendors — vendors are for
    -- other business expenses (electricity, rent, etc.), tracked separately
    -- in sitara_expenses below.
    weaver_id       NVARCHAR(64)   NOT NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',
    order_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_sitara_po_status CHECK (status IN ('pending','partial','received','cancelled'))
);
GO

CREATE TABLE dbo.sitara_purchase_order_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    purchase_order_id   NVARCHAR(64)   NOT NULL,
    product_id          NVARCHAR(64)   NOT NULL,
    quantity            DECIMAL(14,2)  NOT NULL,
    unit_price           DECIMAL(14,2) NOT NULL DEFAULT 0,
    line_total          DECIMAL(14,2)  NULL
);
GO
CREATE INDEX IX_sitara_po_items_po ON dbo.sitara_purchase_order_items(purchase_order_id);
GO
CREATE INDEX IX_sitara_po_items_product ON dbo.sitara_purchase_order_items(product_id);
GO

CREATE TABLE dbo.sitara_orders (
    id                      NVARCHAR(64)   NOT NULL PRIMARY KEY,
    -- NULL for a manual/DM order that never went through BigCommerce checkout.
    bigcommerce_order_id    NVARCHAR(64)   NULL,
    order_number            NVARCHAR(50)   NOT NULL,
    customer_id             NVARCHAR(64)   NULL,
    status                  NVARCHAR(30)   NOT NULL DEFAULT 'awaiting_fulfillment',
    total                   DECIMAL(14,2)  NOT NULL DEFAULT 0,
    source                  NVARCHAR(20)   NOT NULL DEFAULT 'manual',
    -- Bumped every time `status` changes — Phase 4's stale-order poller reads
    -- this to flag anything stuck in the same status too long.
    status_changed_at       DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    flagged                 BIT            NOT NULL DEFAULT 0,
    notes                   NVARCHAR(MAX)  NULL,
    created_by              NVARCHAR(64)   NULL,
    created_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at              DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_sitara_orders_source CHECK (source IN ('bigcommerce','manual')),
    -- Mirrors BigCommerce's own order status list (mapped from their human
    -- strings — e.g. "Awaiting Fulfillment" -> 'awaiting_fulfillment' — in
    -- src/routes/sitara.js's BC_STATUS_MAP) plus 'awaiting_fulfillment' as
    -- the default starting status for a manual order.
    CONSTRAINT CK_sitara_orders_status CHECK (status IN (
        'incomplete','pending','awaiting_payment','awaiting_fulfillment','awaiting_shipment',
        'awaiting_pickup','partially_shipped','shipped','completed','cancelled','declined',
        'refunded','partially_refunded','disputed','manual_verification_required','verified'
    ))
);
GO
CREATE UNIQUE INDEX IX_sitara_orders_bc_id ON dbo.sitara_orders(bigcommerce_order_id) WHERE bigcommerce_order_id IS NOT NULL;
GO
CREATE INDEX IX_sitara_orders_customer ON dbo.sitara_orders(customer_id);
GO
CREATE INDEX IX_sitara_orders_status ON dbo.sitara_orders(status);
GO

CREATE TABLE dbo.sitara_order_items (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    order_id        NVARCHAR(64)   NOT NULL,
    -- Nullable: a BigCommerce line item may not map to a known Sitara
    -- product (catalog sync is out of scope for now) — product_name is the
    -- fallback so the order line is still meaningful either way.
    product_id      NVARCHAR(64)   NULL,
    product_name    NVARCHAR(200)  NOT NULL,
    quantity        DECIMAL(14,2)  NOT NULL,
    unit_price      DECIMAL(14,2)  NOT NULL DEFAULT 0,
    line_total      DECIMAL(14,2)  NULL
);
GO
CREATE INDEX IX_sitara_order_items_order ON dbo.sitara_order_items(order_id);
GO

CREATE TABLE dbo.sitara_razorpay_payments (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    razorpay_payment_id NVARCHAR(100)  NOT NULL,
    amount              DECIMAL(14,2)  NOT NULL,
    status              NVARCHAR(30)   NOT NULL,
    -- NULL is the entire point of reconciliation — a captured payment with
    -- no matched order is exactly what /reconciliation (Phase 3) surfaces.
    order_id            NVARCHAR(64)   NULL,
    captured_at         DATETIME2      NULL,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE UNIQUE INDEX IX_sitara_rzp_payment_id ON dbo.sitara_razorpay_payments(razorpay_payment_id);
GO
CREATE INDEX IX_sitara_rzp_order ON dbo.sitara_razorpay_payments(order_id);
GO

-- Business expenses (electricity, rent, etc.) — vendor-linked, unrelated to
-- stock. Lives alongside Orders/Razorpay under the frontend's "Business" nav
-- grouping, but has nothing to do with the BigCommerce order sync itself.
CREATE TABLE dbo.sitara_expenses (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    vendor_id       NVARCHAR(64)   NOT NULL,
    -- Free-text, not a CHECK-constrained enum — "it can be any type of
    -- expense" per spec (electricity, rent, whatever comes up).
    category        NVARCHAR(100)  NOT NULL,
    description     NVARCHAR(500)  NULL,
    amount          DECIMAL(14,2)  NOT NULL,
    expense_date    DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_sitara_expenses_vendor ON dbo.sitara_expenses(vendor_id);
GO
CREATE INDEX IX_sitara_expenses_date ON dbo.sitara_expenses(expense_date);
GO

CREATE TABLE dbo.sitara_notifications (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    type                NVARCHAR(30)   NOT NULL,
    message             NVARCHAR(500)  NOT NULL,
    related_order_id    NVARCHAR(64)   NULL,
    is_read             BIT            NOT NULL DEFAULT 0,
    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_sitara_notif_type CHECK (type IN ('stale_order','restock'))
);
GO
CREATE INDEX IX_sitara_notif_read ON dbo.sitara_notifications(is_read);
GO

-- FKs added at end for order-safety
ALTER TABLE dbo.sitara_weavers ADD CONSTRAINT FK_sitara_weavers_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_vendors ADD CONSTRAINT FK_sitara_vendors_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_customers ADD CONSTRAINT FK_sitara_customers_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_products ADD CONSTRAINT FK_sitara_products_vendor FOREIGN KEY (vendor_id) REFERENCES dbo.sitara_vendors(id);
GO
ALTER TABLE dbo.sitara_products ADD CONSTRAINT FK_sitara_products_weaver FOREIGN KEY (weaver_id) REFERENCES dbo.sitara_weavers(id);
GO
ALTER TABLE dbo.sitara_products ADD CONSTRAINT FK_sitara_products_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_purchase_orders ADD CONSTRAINT FK_sitara_po_weaver FOREIGN KEY (weaver_id) REFERENCES dbo.sitara_weavers(id);
GO
ALTER TABLE dbo.sitara_purchase_orders ADD CONSTRAINT FK_sitara_po_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_purchase_order_items ADD CONSTRAINT FK_sitara_po_items_po FOREIGN KEY (purchase_order_id) REFERENCES dbo.sitara_purchase_orders(id);
GO
ALTER TABLE dbo.sitara_purchase_order_items ADD CONSTRAINT FK_sitara_po_items_product FOREIGN KEY (product_id) REFERENCES dbo.sitara_products(id);
GO
ALTER TABLE dbo.sitara_orders ADD CONSTRAINT FK_sitara_orders_customer FOREIGN KEY (customer_id) REFERENCES dbo.sitara_customers(id);
GO
ALTER TABLE dbo.sitara_orders ADD CONSTRAINT FK_sitara_orders_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.sitara_order_items ADD CONSTRAINT FK_sitara_order_items_order FOREIGN KEY (order_id) REFERENCES dbo.sitara_orders(id);
GO
ALTER TABLE dbo.sitara_order_items ADD CONSTRAINT FK_sitara_order_items_product FOREIGN KEY (product_id) REFERENCES dbo.sitara_products(id);
GO
ALTER TABLE dbo.sitara_razorpay_payments ADD CONSTRAINT FK_sitara_rzp_order FOREIGN KEY (order_id) REFERENCES dbo.sitara_orders(id);
GO
ALTER TABLE dbo.sitara_notifications ADD CONSTRAINT FK_sitara_notif_order FOREIGN KEY (related_order_id) REFERENCES dbo.sitara_orders(id);
GO
ALTER TABLE dbo.sitara_expenses ADD CONSTRAINT FK_sitara_expenses_vendor FOREIGN KEY (vendor_id) REFERENCES dbo.sitara_vendors(id);
GO
ALTER TABLE dbo.sitara_expenses ADD CONSTRAINT FK_sitara_expenses_user FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
