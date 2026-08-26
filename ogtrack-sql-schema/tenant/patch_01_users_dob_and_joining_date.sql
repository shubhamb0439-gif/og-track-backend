/* =============================================================================
   PATCH: Users — add date_of_birth and joining_date columns
   =============================================================================
   Run against an existing tenant DB that already has 01_core_tenant.sql
   applied (i.e. any tenant provisioned before these two columns existed).
   Idempotent — safe to re-run.

   Context: birthday/work-anniversary tracking needs two more fields on
   dbo.users after the table had already been created on existing tenants —
   `date_of_birth` (nullable; many people fill this in later via the "please
   enter your DOB" prompt rather than at registration time) and
   `joining_date` (nullable; set automatically to the registration date for
   new registrations, but nullable here so existing users without a known
   joining date aren't broken by a NOT NULL default).
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users')
      AND name = 'date_of_birth'
)
    ALTER TABLE dbo.users ADD date_of_birth DATE NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users')
      AND name = 'joining_date'
)
    ALTER TABLE dbo.users ADD joining_date DATE NULL;
GO
