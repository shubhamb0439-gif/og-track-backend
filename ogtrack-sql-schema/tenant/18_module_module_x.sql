/* =============================================================================
   TENANT DATABASE — Part 18: MODULE X
   Provisioned when a company has the 'module_x' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   module_x_views
   Module X's screen is currently just a static text message with no data
   entry of its own — this table exists so the module has a real schema file
   to grow into (e.g. future per-view customization) and so a manager's
   visits can be audited, without blocking today's minimal feature on schema
   design for functionality that doesn't exist yet.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.module_x_views (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    viewed_by         NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    viewed_by_name    NVARCHAR(200)  NULL,
    viewed_at         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_module_x_views_viewed_at ON dbo.module_x_views(viewed_at DESC);
GO
