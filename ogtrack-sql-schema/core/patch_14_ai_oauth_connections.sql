/* =============================================================================
   PATCH: ai_oauth_connections — per-user AIDA OAuth connectors (Google Drive,
   GitHub, Notion, Slack), connect/disconnect/status phase only.
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_06_zoho_connections.sql. Idempotent.

   Deliberately per USER, not per company (unlike Zoho Books, which is a
   company-wide accounting connection) — this is "my own Google Drive", so the
   scope key is (company_id, user_id) for a tenant user, or just (user_id) for
   a masteradmin (company_id NULL — a masteradmin isn't scoped to one
   company). A tenant user_id is only unique WITHIN its own company, so
   company_id must be part of the tenant key; a masteradmin's own admin id is
   already globally unique on its own, hence the two separate filtered unique
   indexes below rather than one plain unique constraint.

   Tokens stored in plain columns — same "no new encryption convention" choice
   already made for zoho_connections.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_oauth_connections', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_oauth_connections (
        id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
        company_id        UNIQUEIDENTIFIER NULL,  -- NULL = this row belongs to a masteradmin, not a tenant user
        user_id           NVARCHAR(64)   NOT NULL, -- tenant user id OR masteradmin admin id, depending on company_id
        provider          NVARCHAR(30)   NOT NULL,
        access_token      NVARCHAR(MAX)  NOT NULL,
        refresh_token     NVARCHAR(MAX)  NULL,     -- some providers (Notion, classic GitHub OAuth Apps) never issue one — access_token alone is the long-lived credential there
        token_expires_at  DATETIME2      NULL,      -- NULL = provider's token doesn't expire (Notion, GitHub's classic flow)
        connected_email   NVARCHAR(200)  NULL,
        connected_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

        CONSTRAINT CK_ai_oauth_connections_provider CHECK (provider IN ('google_drive','github','notion','slack'))
    );

    CREATE UNIQUE INDEX IX_ai_oauth_tenant_scope ON dbo.ai_oauth_connections(company_id, user_id, provider) WHERE company_id IS NOT NULL;
    CREATE UNIQUE INDEX IX_ai_oauth_admin_scope ON dbo.ai_oauth_connections(user_id, provider) WHERE company_id IS NULL;
END
GO
