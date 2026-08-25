/* =============================================================================
   OGCORE DATABASE — dbo.companies

   Reconstructed from the live OGCore schema (INFORMATION_SCHEMA introspection,
   read-only, run once) to close the gap flagged at the top of
   01_platform_core.sql: "companies, platform_admins, and provisioning_log
   already exist in OGCore but were created ad hoc and have no tracked DDL in
   this repo." This file tracks companies only (the one of the three actually
   needed by scripts/provisionStagingDb.js and by AIDA's own tenant lookups —
   see src/db/tenantConnections.js).

   Numbered 00 (before 01_platform_core.sql) since aida_jobs/aida_job_events
   don't reference companies by foreign key, but conceptually this is the
   platform's most foundational table and reads better first.

   Run this against OGCore itself (NOT a tenant database) — or, via
   scripts/provisionStagingDb.js, against a fresh staging database that plays
   the role of both OGCore and one tenant DB at once for preview purposes.
   ============================================================================= */

CREATE TABLE dbo.companies (
    id                  UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    name                NVARCHAR(200)    NOT NULL,
    slug                NVARCHAR(100)    NOT NULL,
    db_name             NVARCHAR(128)    NOT NULL,
    status              NVARCHAR(20)     NOT NULL DEFAULT 'active',
    logo_url            NVARCHAR(500)    NULL,
    primary_color       NVARCHAR(20)     NULL DEFAULT '#C0392B',
    secondary_color     NVARCHAR(20)     NULL,
    accent_color        NVARCHAR(20)     NULL,
    enabled_modules     NVARCHAR(MAX)    NOT NULL DEFAULT '[]',
    custom_modules      NVARCHAR(MAX)    NULL,
    provisioned_at      DATETIME2        NULL,
    created_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2        NULL
);
GO
CREATE UNIQUE INDEX UX_companies_slug ON dbo.companies(slug);
GO
