/* =============================================================================
   TENANT DATABASE — Part 14: TOKEN
   Provisioned when a company has the 'token' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   tokens
   Simple log of named tokens and how much of each was consumed. Used by the
   Token module's "add a token" popup + list view.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.tokens (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name              NVARCHAR(200)  NOT NULL,
    consumed          DECIMAL(18,2)  NOT NULL DEFAULT 0,
    created_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_by_name   NVARCHAR(200)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_tokens_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_tokens_created_at ON dbo.tokens(created_at DESC);
CREATE INDEX IX_tokens_name ON dbo.tokens(name);
GO
