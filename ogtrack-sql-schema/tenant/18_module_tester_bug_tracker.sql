/* =============================================================================
   TENANT DATABASE — Part 18: TESTER BUG TRACKER
   Provisioned when a company has the 'tester_bug_tracker' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   tester_bugs
   A lightweight bug log dedicated to the tester role (separate from the
   fuller dev-workflow dbo.bugs table used by the Projects/Bugs module).
   Priority drives the card highlighting on the frontend (High = red), and
   status gives a simple open/in_progress/resolved lifecycle.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.tester_bugs (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    title             NVARCHAR(500)  NOT NULL,
    description       NVARCHAR(MAX)  NULL,
    priority          NVARCHAR(20)   NOT NULL DEFAULT 'Medium',
                       -- Low | Medium | High
    status            NVARCHAR(20)   NOT NULL DEFAULT 'open',
                       -- open | in_progress | resolved
    created_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_by_name   NVARCHAR(200)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    resolved_at       DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_tester_bugs_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_tester_bugs_status ON dbo.tester_bugs(status);
CREATE INDEX IX_tester_bugs_priority ON dbo.tester_bugs(priority);
CREATE INDEX IX_tester_bugs_created_at ON dbo.tester_bugs(created_at DESC);
GO
