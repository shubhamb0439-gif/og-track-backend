/* =============================================================================
   PATCH: zoho_connections, zoho_company_links — AIDA roadmap item 5 (Zoho Books)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as every
   other patch_*.sql file. Idempotent.

   Context: this is deliberately TWO tables, not one, because a Zoho
   connection is per ZOHO ORGANIZATION, not per OG Track company — confirmed
   live: Sitara Drapes is its own separate OG Track tenant database
   (sitara_drapes), but its bookkeeping lives inside OG Plus's own Zoho
   organization under a dedicated Zoho "Branch", not a separate Zoho
   subscription. zoho_connections holds one row per real OAuth connection
   (one per distinct Zoho organization); zoho_company_links maps N companies
   onto one connection, each with its own optional branch_id for filtering
   that company's own transactions out of a shared org. CAJO gets its own
   connection with no branch_id (single-company org, no filtering needed);
   OG Plus and Sitara share one connection with different branch_ids.

   Tokens are stored in plain columns, matching every other secret in this
   codebase (API keys live in .env, not encrypted-at-rest) — no new
   encryption convention introduced here.
   ============================================================================= */

IF OBJECT_ID('dbo.zoho_connections', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.zoho_connections (
        id                   NVARCHAR(40)   NOT NULL PRIMARY KEY,
        display_name         NVARCHAR(200)  NOT NULL,
        zoho_organization_id NVARCHAR(50)   NOT NULL,
        access_token         NVARCHAR(MAX)  NOT NULL,
        refresh_token        NVARCHAR(MAX)  NOT NULL,
        token_expires_at     DATETIME2      NOT NULL,
        api_domain           NVARCHAR(200)  NULL, -- Zoho returns the real per-account API host at token-exchange time; prefer it over config's static default when present
        connected_at         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        connected_by         NVARCHAR(200)  NULL,
        CONSTRAINT UQ_zoho_connections_org UNIQUE (zoho_organization_id)
    );
END
GO

IF OBJECT_ID('dbo.zoho_company_links', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.zoho_company_links (
        id                NVARCHAR(40)  NOT NULL PRIMARY KEY,
        company_id        UNIQUEIDENTIFIER NOT NULL,
        zoho_connection_id NVARCHAR(40) NOT NULL,
        zoho_branch_id    NVARCHAR(50)  NULL, -- NULL = no branch filtering (this company IS the whole org, e.g. CAJO)
        created_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_zoho_company_links_company UNIQUE (company_id),
        CONSTRAINT FK_zoho_company_links_connection FOREIGN KEY (zoho_connection_id)
            REFERENCES dbo.zoho_connections(id)
    );
END
GO
