/* =============================================================================
   TENANT DATABASE — Part 18: TEST MODULE
   Provisioned when a company has the 'test_module' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   test_module_checks
   Test Module has no real business data model — it's a lightweight
   diagnostic page restricted to the 'tester' and 'developer' roles (see
   routes/test_module.js) used to confirm the stack is wired up correctly in
   a given environment. This table only logs the handful of "checks"
   (pings) a tester/developer runs from that page, so there's something real
   to show instead of a dead end.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.test_module_checks (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    role              NVARCHAR(50)   NULL,
    note              NVARCHAR(500)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_test_module_checks_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_test_module_checks_user_id ON dbo.test_module_checks(user_id);
CREATE INDEX IX_test_module_checks_created_at ON dbo.test_module_checks(created_at);
GO
