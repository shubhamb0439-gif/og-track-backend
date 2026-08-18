/* =============================================================================
   PATCH: Test Cases — add precondition and is_bugged columns
   =============================================================================
   Run against an existing tenant DB that already has 12_module_test_cases.sql
   applied (e.g. ogplus, provisioned before these two columns existed).
   Idempotent — safe to re-run.

   Context: the Test Cases module needed two more fields after the table had
   already been created on at least one tenant: `precondition` (setup/
   pre-condition text for a test case) and `is_bugged` (flag to avoid filing
   duplicate bug reports for a test case whose failure was already reported).
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.test_cases')
      AND name = 'precondition'
)
    ALTER TABLE dbo.test_cases ADD precondition NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.test_cases')
      AND name = 'is_bugged'
)
    ALTER TABLE dbo.test_cases ADD is_bugged BIT NOT NULL DEFAULT 0;
GO
