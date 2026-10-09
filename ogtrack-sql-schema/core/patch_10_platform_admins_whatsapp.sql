/* =============================================================================
   PATCH: platform_admins — add whatsapp_number (AIDA roadmap item 9's
   external-contact file-forwarding feature)
   =============================================================================
   Run against OGCore itself. Idempotent.

   Context: both existing master admin rows share the generic name "Master
   Admin" — no reliable way to resolve "send this to Shubham" or "to Sanj"
   to the right real person. This column + the name update below give
   contact-chat's file-forwarding feature a single source of truth for both
   identity (name) and destination (whatsapp_number) per admin.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.platform_admins') AND name = 'whatsapp_number')
    ALTER TABLE dbo.platform_admins ADD whatsapp_number NVARCHAR(20) NULL;
GO
