/* =============================================================================
   PATCH: ai_contacts — add whatsapp_number (AIDA roadmap item 9)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_04_ai_contacts.sql. Idempotent.

   Context: "message Shubham on WhatsApp" needs a name -> WhatsApp number
   lookup, same shape as the existing name -> email lookup this table
   already does for send_email. A contact saved for WhatsApp-only use may
   have no email at all, so `email` (originally NOT NULL) is relaxed to
   nullable here — the new CHECK constraint ensures a contact always has AT
   LEAST one real way to reach them, not neither.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_contacts') AND name = 'whatsapp_number')
    ALTER TABLE dbo.ai_contacts ADD whatsapp_number NVARCHAR(20) NULL;
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.ai_contacts') AND name = 'email' AND is_nullable = 0
)
    ALTER TABLE dbo.ai_contacts ALTER COLUMN email NVARCHAR(200) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ai_contacts_has_identifier')
    ALTER TABLE dbo.ai_contacts ADD CONSTRAINT CK_ai_contacts_has_identifier CHECK (email IS NOT NULL OR whatsapp_number IS NOT NULL);
GO
