/* =============================================================================
   PATCH: platform_admins — add profile_picture_url (master admin's own
   profile photo — surfaced in the masteradmin web panel and the Android
   app, both reading/writing the same column so it's one identity across
   every surface).
   =============================================================================
   Run against OGCore itself. Idempotent.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.platform_admins') AND name = 'profile_picture_url')
    ALTER TABLE dbo.platform_admins ADD profile_picture_url NVARCHAR(500) NULL;
GO
