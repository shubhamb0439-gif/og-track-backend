/* =============================================================================
   PATCH: ai_contacts — scope contacts per master admin (owner_id)
   =============================================================================
   Run against OGCore itself (NOT a tenant database). Idempotent.

   Context: confirmed live there are 2 real master admins (masteradmin@ogplus.com,
   sp@sanj.co) sharing this ONE global ai_contacts table — saving a contact
   named "Lalith" as one admin would silently overwrite a DIFFERENT "Lalith"
   saved by the other admin, since the existing upsert-by-name lookup has no
   concept of who saved it. owner_id scopes every contact to the admin who
   saved it; existing rows are backfilled to the current single active admin
   (the only realistic owner for anything saved before this patch existed)
   rather than left NULL and ambiguous.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_contacts') AND name = 'owner_id')
    ALTER TABLE dbo.ai_contacts ADD owner_id NVARCHAR(64) NULL;
GO

-- Backfill: every contact saved before this patch existed only had one real
-- owner in practice (whichever admin happened to be the one using AIDA's
-- contact features) — attribute them to the earliest-registered active admin
-- rather than leave them ownerless and invisible to everyone.
IF EXISTS (SELECT 1 FROM dbo.ai_contacts WHERE owner_id IS NULL)
BEGIN
    DECLARE @defaultOwner NVARCHAR(64) = (SELECT TOP 1 id FROM dbo.platform_admins WHERE status = 'active' ORDER BY created_at ASC);
    IF @defaultOwner IS NOT NULL
        UPDATE dbo.ai_contacts SET owner_id = @defaultOwner WHERE owner_id IS NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_contacts_owner' AND object_id = OBJECT_ID('dbo.ai_contacts'))
    CREATE INDEX IX_ai_contacts_owner ON dbo.ai_contacts(owner_id);
GO
