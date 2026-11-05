/* =============================================================================
   PATCH: platform_admins — Microsoft SSO login (AIDA roadmap item 18 — MFA)
   =============================================================================
   Run against OGCore. Idempotent.

   microsoft_oid is the Entra object id returned in the SSO id_token — the
   stable identifier an account is matched on for every login after the
   first (never the email alone, since email can be changed/reused).
   sso_only exists but is NOT flipped automatically by this patch or by any
   code shipped alongside it yet — every existing admin keeps logging in with
   their password completely unchanged until this is deliberately turned on
   for a specific account later.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.platform_admins') AND name = 'microsoft_oid')
    ALTER TABLE dbo.platform_admins ADD microsoft_oid NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.platform_admins') AND name = 'UQ_platform_admins_microsoft_oid')
    CREATE UNIQUE INDEX UQ_platform_admins_microsoft_oid ON dbo.platform_admins(microsoft_oid) WHERE microsoft_oid IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.platform_admins') AND name = 'sso_only')
    ALTER TABLE dbo.platform_admins ADD sso_only BIT NOT NULL DEFAULT 0;
GO
