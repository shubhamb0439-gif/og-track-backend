/* =============================================================================
   PATCH: ai_email_log — track the real WhatsApp delivery outcome, not just
   whether Meta's API accepted the send
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_02/03/05. Idempotent — safe to re-run.

   Context: patch_05 added whatsapp_sent/whatsapp_error, but that only ever
   records whether Meta's /messages API call returned 2xx (accepted/queued) —
   a REAL incident (2026-10-14) showed whatsapp_sent=true for an email alert
   the recipient never actually received. Meta reports true delivery/failure
   ASYNCHRONOUSLY, as a separate "statuses" webhook callback keyed by the
   message id the send call returns — this column is what lets that later
   callback (see routes/whatsapp.js) be matched back to the row it belongs to.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ai_email_log') AND name = 'whatsapp_message_id')
    ALTER TABLE dbo.ai_email_log ADD whatsapp_message_id NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.ai_email_log') AND name = 'IX_ai_email_log_whatsapp_message_id')
    CREATE INDEX IX_ai_email_log_whatsapp_message_id ON dbo.ai_email_log (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
GO
