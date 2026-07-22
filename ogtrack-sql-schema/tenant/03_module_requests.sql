/* =============================================================================
   TENANT DATABASE — Part 3: REQUESTS (sub-tickets)
   Provisioned when 'sub_tickets' module is enabled.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   sub_tickets  (was: Firestore `sub_tickets` collection)
   ticket_id is the human-readable code, e.g. 'REQ-001'
   Visibility rule from the old app (superadmin/manager/accounts_manager see
   all; everyone else sees only tickets they raised) is enforced in the API
   layer, not in SQL — kept out of this schema deliberately.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.sub_tickets (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    ticket_id       NVARCHAR(30)   NOT NULL UNIQUE,
    raised_by_id    NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    raised_by_name  NVARCHAR(200)  NULL,
    subject         NVARCHAR(500)  NULL,
    description     NVARCHAR(MAX)  NULL,
    status          NVARCHAR(30)   NOT NULL DEFAULT 'pending',
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_sub_tickets_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_sub_tickets_raised_by ON dbo.sub_tickets(raised_by_id);
CREATE INDEX IX_sub_tickets_created_at ON dbo.sub_tickets(created_at DESC);
GO
