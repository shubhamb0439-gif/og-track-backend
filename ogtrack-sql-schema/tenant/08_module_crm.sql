/* =============================================================================
   TENANT DATABASE — Part 8: SALES / CRM (Phase 1 of the Inventory+CRM addon)
   Provisioned when the 'crm' module is enabled.

   Models the funnel from the Cajo ERP walkthrough:
     Lead -> Contacted -> Qualified -> Prospect -> Customer
   as ONE table with a `stage` column, plus a `kanban_status` sub-column that
   only matters while stage = 'lead' (New / Contacted / Qualified). This
   avoids having to migrate a row between three separate tables every time
   it moves forward in the funnel — it just updates in place.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   crm_contacts — every lead, prospect, and customer is a row here.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.crm_contacts (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name                NVARCHAR(200)  NOT NULL,               -- contact person's name
    company_name        NVARCHAR(200)  NULL,
    email               NVARCHAR(200)  NULL,
    phone               NVARCHAR(50)   NULL,
    source              NVARCHAR(100)  NULL,                   -- e.g. 'Website', 'Referral'
    assigned_to         NVARCHAR(64)   NULL REFERENCES dbo.users(id),

    stage               NVARCHAR(20)   NOT NULL DEFAULT 'lead',    -- lead | prospect | customer | lost
    kanban_status       NVARCHAR(20)   NOT NULL DEFAULT 'new',     -- new | contacted | qualified (only meaningful while stage='lead')

    -- Leads & Prospects: an internal, non-binding forecast of deal size.
    estimated_value     DECIMAL(14,2)  NULL,

    -- Customers only: real, already-earned revenue. Updated by the sales
    -- log below (dbo.crm_sales), never edited directly by the UI.
    lifetime_value      DECIMAL(14,2)  NOT NULL DEFAULT 0,

    -- Customers only: relationship health, independent of $ value.
    customer_status     NVARCHAR(20)   NULL,                   -- active | at_risk | inactive

    notes               NVARCHAR(MAX)  NULL,
    lost_reason         NVARCHAR(500)  NULL,                   -- filled in when stage moves to 'lost'

    created_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_crm_contacts_stage ON dbo.crm_contacts(stage);
GO
CREATE INDEX IX_crm_contacts_assigned ON dbo.crm_contacts(assigned_to);
GO

/* ---------------------------------------------------------------------------
   crm_sales — one row per completed sale. Recording a sale here is what
   actually moves the needle on a customer's lifetime_value (the app
   recomputes/increments it from this table rather than trusting a client-
   supplied number), and gives you a real, auditable sales history instead
   of a single running total.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.crm_sales (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    contact_id      NVARCHAR(64)   NOT NULL REFERENCES dbo.crm_contacts(id),
    amount          DECIMAL(14,2)  NOT NULL,
    sale_date       DATE           NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
    notes           NVARCHAR(500)  NULL,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_crm_sales_contact ON dbo.crm_sales(contact_id);
GO
