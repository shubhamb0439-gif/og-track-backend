/* =============================================================================
   TENANT DATABASE — Part 18: AIDA VPS TEST MODULE 1794226721656
   Provisioned when a company has the 'aida_vps_test_module_1794226721656'
   module enabled. The module's only endpoint returns a static greeting, so
   this table is a minimal placeholder that is never read or written.
   ============================================================================= */

CREATE TABLE dbo.aida_vps_test_module_1794226721656_meta (
    id          NVARCHAR(64)   NOT NULL PRIMARY KEY,
    created_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
