/* =============================================================================
   MODULE: CRM  (v2 — Cajo-style leads/prospects/customers/customer POs)
   =============================================================================
   Idempotent — re-running against an existing tenant DB silently skips what's
   already there.

   FK constraints that reference cross-module tables (e.g. inv_items) are added
   at the END of this file via ALTER TABLE, so table creation is order-safe
   regardless of which other module scripts have already run.
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
    assigned_to     NVARCHAR(64)   NULL,
    converted_to_prospect_id NVARCHAR(64) NULL,
    converted_at    DATETIME2      NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(64)   NULL,
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_leads_status ON dbo.leads(status);
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
    assigned_to     NVARCHAR(64)   NULL,
    original_lead_id NVARCHAR(64)  NULL,
    converted_to_customer_id NVARCHAR(64) NULL,
    converted_at    DATETIME2      NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(64)   NULL,
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_prospects_status ON dbo.prospects(status);
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
    assigned_to           NVARCHAR(64)   NULL,
    original_prospect_id  NVARCHAR(64)   NULL,
    created_by            NVARCHAR(64)   NULL,
    created_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by            NVARCHAR(64)   NULL,
    updated_at            DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_customers_status ON dbo.customers(status);
GO

CREATE TABLE dbo.customer_purchase_orders (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    po_number       NVARCHAR(50)   NOT NULL,
    customer_id     NVARCHAR(64)   NOT NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'open',
    order_date      DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    delivery_date   DATE           NULL,
    total_value     DECIMAL(14,2)  NULL,
    notes           NVARCHAR(MAX)  NULL,
    created_by      NVARCHAR(64)   NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_customer_po_status CHECK (status IN ('open','late','fulfilled','closed','cancelled'))
);
GO
CREATE INDEX IX_customer_po_customer ON dbo.customer_purchase_orders(customer_id);
GO

CREATE TABLE dbo.customer_purchase_order_items (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    purchase_order_id   NVARCHAR(64)   NOT NULL,
    item_id             NVARCHAR(64)   NOT NULL,
    quantity            DECIMAL(14,2)  NOT NULL,
    quantity_fulfilled  DECIMAL(14,2)  NOT NULL DEFAULT 0,
    unit_price          DECIMAL(14,2)  NULL,
    line_total          DECIMAL(14,2)  NULL
);
GO
CREATE INDEX IX_customer_po_items_po ON dbo.customer_purchase_order_items(purchase_order_id);
GO

-- FKs to same-module tables (safe: all created above by now)
ALTER TABLE dbo.prospects ADD CONSTRAINT FK_prospects_lead FOREIGN KEY (original_lead_id) REFERENCES dbo.leads(id);
GO
ALTER TABLE dbo.customers ADD CONSTRAINT FK_customers_prospect FOREIGN KEY (original_prospect_id) REFERENCES dbo.prospects(id);
GO
ALTER TABLE dbo.customer_purchase_orders ADD CONSTRAINT FK_customer_po_customer FOREIGN KEY (customer_id) REFERENCES dbo.customers(id);
GO
ALTER TABLE dbo.customer_purchase_order_items ADD CONSTRAINT FK_customer_po_items_po FOREIGN KEY (purchase_order_id) REFERENCES dbo.customer_purchase_orders(id);
GO

-- FKs to CORE tables (users exists from module 01, always safe)
ALTER TABLE dbo.leads ADD CONSTRAINT FK_leads_assigned FOREIGN KEY (assigned_to) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.leads ADD CONSTRAINT FK_leads_created FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.prospects ADD CONSTRAINT FK_prospects_assigned FOREIGN KEY (assigned_to) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.prospects ADD CONSTRAINT FK_prospects_created FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.customers ADD CONSTRAINT FK_customers_assigned FOREIGN KEY (assigned_to) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.customers ADD CONSTRAINT FK_customers_created FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO
ALTER TABLE dbo.customer_purchase_orders ADD CONSTRAINT FK_customer_po_created FOREIGN KEY (created_by) REFERENCES dbo.users(id);
GO

-- FKs to OTHER module tables — wrapped in existence checks. If the referenced
-- module hasn't been provisioned yet, we skip the FK gracefully (it'll get
-- picked up next time provisioning runs after inventory is enabled).
IF OBJECT_ID('dbo.inv_items', 'U') IS NOT NULL
    ALTER TABLE dbo.customer_purchase_order_items ADD CONSTRAINT FK_customer_po_items_item FOREIGN KEY (item_id) REFERENCES dbo.inv_items(id);
GO