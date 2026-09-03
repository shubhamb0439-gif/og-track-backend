/* =============================================================================
   PATCH: Users — add password-reset token columns
   =============================================================================
   Run against an existing tenant DB that already has 01_core_tenant.sql
   applied. Idempotent — safe to re-run.

   Context: "forgot password" flow (src/routes/users.js) — reset_token_hash
   stores a SHA-256 hash of the reset token, never the raw token (the raw
   token only ever exists in the emailed link, so a DB read alone can't be
   used to reset someone's password). reset_token_expires bounds how long a
   link stays valid (1 hour, enforced in code). Both nullable — most users
   never have an active reset request.
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users')
      AND name = 'reset_token_hash'
)
    ALTER TABLE dbo.users ADD reset_token_hash NVARCHAR(64) NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users')
      AND name = 'reset_token_expires'
)
    ALTER TABLE dbo.users ADD reset_token_expires DATETIME2 NULL;
GO
