/* =============================================================================
   MODULE: CRM  (v2 — Cajo-style, replaces the v1 unified contacts table)
   =============================================================================
   This schema follows the leads → prospects → customers pipeline as separate
   tables (not a single "contacts" table with a stage field), with conversion
   tracking preserved via original_lead_id / original_prospect_id back-references.

   Customer POs — actual purchase orders CUSTOMERS place with us (distinct from
   vendor POs which live in the Inventory module) — sit on top of Customers.

   Note: this schema is idempotent. Re-running it against an existing tenant DB
   silently skips anything that already exists — same convention as every other
   schema file in this tree.
   ========================================================================== */

CREATE TABLE dbo.leads (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    company         NVARCHAR(200)  NULL,
    email           NVARCHAR(200)  NULL,
    phone           NVARCHAR(50)   NULL,
    position        NVARCHAR(100)  NULL,
    source          NVARCHAR(100)  NULL,
    status          NVARCHAR(50)   NOT NULL DEFAULT 'new',
    estimated_value DECIMAL(14,2)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    assigned_to     NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    converted_to_prospect_id NVARCHAR(64) NULL,
    converted_at    DATETIME2      NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_leads_status ON dbo.leads(status);
GO
CREATE INDEX IX_leads_assigned_to ON dbo.leads(assigned_to);
GO

CREATE TABLE dbo.prospects (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    company         NVARCHAR(200)  NULL,
    email           NVARCHAR(200)  NULL,
    phone           NVARCHAR(50)   NULL,
    position        NVARCHAR(100)  NULL,
    source          NVARCHAR(100)  NULL,
    status          NVARCHAR(50)   NOT NULL DEFAULT 'engaged',
    estimated_value DECIMAL(14,2)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    assigned_to     NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    original_lead_id NVARCHAR(64)  NULL REFERENCES dbo.leads(id),
    converted_to_customer_id NVARCHAR(64) NULL,
    converted_at    DATETIME2      NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_prospects_status ON dbo.prospects(status);
GO
CREATE INDEX IX_prospects_original_lead ON dbo.prospects(original_lead_id);
GO

CREATE TABLE dbo.customers (
    id                    NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                  NVARCHAR(200)  NOT NULL,
    company               NVARCHAR(200)  NULL,
    email                 NVARCHAR(200)  NULL,
    phone                 NVARCHAR(50)   NULL,
    position              NVARCHAR(100)  NULL,
    source                NVARCHAR(100)  NULL,
    status                NVARCHAR(50)   NOT NULL DEFAULT 'active',
    lifetime_value        DECIMAL(14,2)  NOT NULL DEFAULT 0,
    billing_address       NVARCHAR(500)  NULL,
    shipping_address      NVARCHAR(500)  NULL,
    notes                 NVARCHAR(MAX)  NULL,
    assigned_to           NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    original_prospect_id  NVARCHAR(64)   NULL REFERENCES dbo.prospects(id),
    created_by            NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by            NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    updated_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_customers_status ON dbo.customers(status);
GO
CREATE INDEX IX_customers_original_prospect ON dbo.customers(original_prospect_id);
GO

CREATE TABLE dbo.customer_purchase_orders (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    po_number       NVARCHAR(50)   NOT NULL,
    customer_id     NVARCHAR(64)   NOT NULL REFERENCES dbo.customers(id),
    status          NVARCHAR(20)   NOT NULL DEFAULT 'open',
    order_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    delivery_date   DATE           NULL,
    total_value     DECIMAL(14,2)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_customer_po_status CHECK (status IN ('open','late','fulfilled','closed','cancelled'))
);
GO
CREATE INDEX IX_customer_po_customer ON dbo.customer_purchase_orders(customer_id);
GO
CREATE INDEX IX_customer_po_status ON dbo.customer_purchase_orders(status);
GO

CREATE TABLE dbo.customer_purchase_order_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    purchase_order_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.customer_purchase_orders(id),
    item_id             NVARCHAR(64)   NOT NULL REFERENCES dbo.inv_items(id),
    quantity            DECIMAL(14,2)  NOT NULL,
    quantity_fulfilled  DECIMAL(14,2)  NOT NULL DEFAULT 0,
    unit_price          DECIMAL(14,2)  NULL,
    line_total          DECIMAL(14,2)  NULL
);
GO
CREATE INDEX IX_customer_po_items_po ON dbo.customer_purchase_order_items(purchase_order_id);
GO
CREATE INDEX IX_customer_po_items_item ON dbo.customer_purchase_order_items(item_id);
GO