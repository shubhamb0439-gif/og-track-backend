/* =============================================================================
   PATCH: login_attempts — audit trail for every masteradmin and tenant-user
   login attempt (AIDA roadmap item 21 — security hardening)
   =============================================================================
   Run against OGCore (NOT a tenant database) — a single shared table covers
   both login surfaces (masteradmin.js and users.js), distinguished by
   `scope` + `company_slug` (the latter NULL for masteradmin attempts).
   Idempotent — safe to re-run.

   No FK to platform_admins/users: a failed attempt may not resolve to a real
   account at all (wrong email), so this deliberately stores the raw email
   string tried, not an id.
   ============================================================================= */

IF OBJECT_ID('dbo.login_attempts', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.login_attempts (
        id            BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        scope         NVARCHAR(20)   NOT NULL, -- 'masteradmin' | 'tenant_user'
        company_slug  NVARCHAR(100)  NULL,     -- NULL for masteradmin attempts
        email_tried   NVARCHAR(320)  NOT NULL,
        ip            NVARCHAR(64)   NULL,
        success       BIT            NOT NULL,
        created_at    DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.login_attempts') AND name = 'IX_login_attempts_email_created')
    CREATE INDEX IX_login_attempts_email_created ON dbo.login_attempts(email_tried, created_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.login_attempts') AND name = 'IX_login_attempts_ip_created')
    CREATE INDEX IX_login_attempts_ip_created ON dbo.login_attempts(ip, created_at DESC);
GO
