/* =============================================================================
   PATCH: ai_email_log — record WhatsApp send outcome
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_02/03/04. Idempotent — safe to re-run.

   Context: sendWhatsAppMessage (src/aida/whatsapp.js) deliberately swallows
   failures so a notification problem never crashes the email-processing
   job — but that also meant a failure was completely invisible: a real
   incident (2026-10-05) showed the only way to tell whether an alert
   actually sent was to manually run a live test script. These two columns
   make that outcome queryable per email instead.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_email_log') AND name = 'whatsapp_sent')
    ALTER TABLE dbo.ai_email_log ADD whatsapp_sent BIT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_email_log') AND name = 'whatsapp_error')
    ALTER TABLE dbo.ai_email_log ADD whatsapp_error NVARCHAR(MAX) NULL;
GO
