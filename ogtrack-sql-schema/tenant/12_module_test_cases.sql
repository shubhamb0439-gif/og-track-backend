/* =============================================================================
   TENANT DATABASE — Part 12: TEST CASES
   Provisioned when a company has the 'test_cases' module enabled.
   Requires 01_core_tenant.sql (dbo.users, dbo.id_counters) and
   02_module_projects.sql (dbo.projects) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   test_cases
   id is a human-readable code, e.g. 'PRJ-TC-001' (see id_counters / usp_next_counter,
   same mechanism as bugs, using a separate counter key so numbering doesn't
   collide with bug IDs on the same project).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.test_cases (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    project_id        NVARCHAR(64)   NOT NULL REFERENCES dbo.projects(id),
    title             NVARCHAR(500)  NOT NULL,
    description       NVARCHAR(MAX)  NULL,        -- description / steps to execute
    precondition      NVARCHAR(MAX)  NULL,        -- setup required before running the test
    expected_result   NVARCHAR(MAX)  NULL,
    actual_result     NVARCHAR(MAX)  NULL,
    status            NVARCHAR(20)   NOT NULL DEFAULT 'Not Run',
                       -- Not Run | Pass | Fail | Blocked | N/A
    is_bugged         BIT            NOT NULL DEFAULT 0,  -- true once a bug has been filed for this test case's failure
    created_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    updated_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_test_cases_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_test_cases_project_id ON dbo.test_cases(project_id);
CREATE INDEX IX_test_cases_status ON dbo.test_cases(status);
CREATE INDEX IX_test_cases_created_at ON dbo.test_cases(created_at DESC);
GO
