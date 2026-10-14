/* =============================================================================
   TENANT DATABASE — Part 18: BUG MANAGEMENT
   Provisioned when a company has the 'bug_management' module enabled.
   Requires 01_core_tenant.sql (dbo.users) and 02_module_projects.sql
   (dbo.bugs) to have been run first — see MODULE_DEPENDENCIES in
   src/utils/provisioning.js, which forces 'bugs' to always be provisioned
   alongside 'bug_management'.

   This is a Tester-only workflow layered on top of the EXISTING dbo.bugs
   table (the 'bugs' module) rather than a parallel duplicate-bugs table:
   a Tester can re-order a bug's priority relative to other bugs, and assign
   a developer to it, without needing the full bug-editor UI/permissions.
   Adds two new nullable columns + supporting index/FK to dbo.bugs.
   Idempotent — guarded the same way the existing patch_*.sql files are, so
   it's safe to re-run against a tenant that already has these columns.
   ========================================================================== */

-- priority_rank: lower value = higher priority. NULL = not yet ranked by a
-- Tester (unranked bugs sort after ranked ones in the UI).
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.bugs')
      AND name = 'priority_rank'
)
    ALTER TABLE dbo.bugs ADD priority_rank INT NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.bugs')
      AND name = 'assigned_developer_id'
)
    ALTER TABLE dbo.bugs ADD assigned_developer_id NVARCHAR(64) NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.bugs')
      AND name = 'assigned_developer_name'
)
    ALTER TABLE dbo.bugs ADD assigned_developer_name NVARCHAR(200) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bugs_priority_rank' AND object_id = OBJECT_ID('dbo.bugs'))
    CREATE INDEX IX_bugs_priority_rank ON dbo.bugs(priority_rank);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_bugs_assigned_developer')
    ALTER TABLE dbo.bugs ADD CONSTRAINT FK_bugs_assigned_developer FOREIGN KEY (assigned_developer_id) REFERENCES dbo.users(id);
GO
