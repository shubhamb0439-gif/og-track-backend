/* =============================================================================
   PATCH: users — Microsoft SSO login (AIDA roadmap item 18, Phase 2 —
   tenant-user SSO, every company, by default)
   =============================================================================
   Run against EACH tenant database (NOT OGCore — this is the per-company
   `users` table). Idempotent. Also wired into provisioning.js's unconditional
   patch list, so every NEWLY provisioned company gets this automatically —
   this file still needs to be run by hand against every EXISTING tenant DB.

   microsoft_oid is the Entra/Microsoft Account object id returned in the SSO
   id_token — matched within THIS company's own users table only (another
   company's user with the same Microsoft account gets a completely separate
   row, since microsoft_oid is only unique per tenant DB, not platform-wide).
   sso_only is NOT flipped automatically by any code shipped with this patch —
   every existing tenant user keeps logging in with their password completely
   unchanged until this is deliberately turned on for a specific account.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'microsoft_oid')
    ALTER TABLE dbo.users ADD microsoft_oid NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.users') AND name = 'UQ_users_microsoft_oid')
    CREATE UNIQUE INDEX UQ_users_microsoft_oid ON dbo.users(microsoft_oid) WHERE microsoft_oid IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'sso_only')
    ALTER TABLE dbo.users ADD sso_only BIT NOT NULL DEFAULT 0;
GO
