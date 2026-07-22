/* =============================================================================
   TENANT DATABASE — Part 6: ACCOUNTING (Clients / Timer / EOD Reports)
   Provisioned when any of 'acc_clients', 'acc_timer', 'acc_eod' are enabled.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   clients  (was: Firestore `clients` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.clients (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(300)  NOT NULL,
    contact_name    NVARCHAR(200)  NULL,
    contact_email   NVARCHAR(320)  NULL,
    contact_phone   NVARCHAR(30)   NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'active',
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_clients_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO

/* ---------------------------------------------------------------------------
   time_entries  (was: Firestore `timeEntries` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.time_entries (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    accountant_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    client_id       NVARCHAR(64)   NULL REFERENCES dbo.clients(id),
    date            DATE           NOT NULL,
    hours           DECIMAL(5,2)   NULL,
    task            NVARCHAR(500)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_time_entries_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_time_entries_accountant_date ON dbo.time_entries(accountant_id, date);
GO

/* ---------------------------------------------------------------------------
   eod_reports  (was: Firestore `eodReports` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.eod_reports (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    accountant_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    date            DATE           NOT NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'submitted',  -- submitted | reviewed | flagged
    summary         NVARCHAR(MAX)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_eod_reports_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_eod_reports_accountant_date ON dbo.eod_reports(accountant_id, date);
GO

/* ---------------------------------------------------------------------------
   eod_routes  (was: Firestore `eodRoutes` collection)
   One reviewer per accountant — old app deleted-then-recreated the row on
   every update; UNIQUE constraint + upsert (MERGE) reproduces that cleanly.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.eod_routes (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    accountant_id     NVARCHAR(64)   NOT NULL UNIQUE REFERENCES dbo.users(id),
    accountant_name   NVARCHAR(200)  NULL,
    reviewer_id       NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    reviewer_name     NVARCHAR(200)  NULL,
    updated_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
