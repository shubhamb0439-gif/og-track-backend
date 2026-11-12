/* =============================================================================
   PATCH: Sitara — attach a document/photo to an Expense or a Weaver PO
   =============================================================================
   Idempotent — safe to re-run.

   Both new columns are a plain URL + the original filename, same two-field
   shape as the existing branding-logo/profile-picture convention
   (platform_admins.profile_picture_url / companies.logo_url) — the actual
   bytes live in Azure Blob Storage (uploaded via the existing generic
   POST /api/:slug/upload endpoint), this patch only adds somewhere to store
   the resulting URL on the record itself. One attachment per record (a
   single bill/invoice per expense, a single supporting document per PO) —
   not a multi-file gallery, per the actual request.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_expenses') AND name = 'attachment_url')
    ALTER TABLE dbo.sitara_expenses ADD attachment_url NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_expenses') AND name = 'attachment_name')
    ALTER TABLE dbo.sitara_expenses ADD attachment_name NVARCHAR(260) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_purchase_orders') AND name = 'attachment_url')
    ALTER TABLE dbo.sitara_purchase_orders ADD attachment_url NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_purchase_orders') AND name = 'attachment_name')
    ALTER TABLE dbo.sitara_purchase_orders ADD attachment_name NVARCHAR(260) NULL;
GO
