/* =============================================================================
   PATCH: zoho_company_links.zoho_customer_ids_filter — AIDA roadmap item 5
   =============================================================================
   Run against OGCore itself (NOT a tenant database). Idempotent.

   Context: live-tested against OG Plus's real Zoho org and found it does NOT
   use Zoho's "Locations" (formerly Branches) feature at all — it's disabled
   org-wide (confirmed in Zoho's own Settings UI). Sitara Drapes is instead
   isolated by billing ALL its sales to three specific placeholder customer
   contacts ("Sitara Drapes Intrastate/Interstate/-Overseas customers" — a
   GST-jurisdiction bookkeeping convention), confirmed live by inspecting
   those contacts' real invoices (SIT-00166 etc.) in the Zoho UI.

   zoho_branch_id (patch_06) is kept as-is for any company that DOES use
   real Zoho Locations later — this column is the alternative mechanism for
   a company whose separation is by named customer contacts instead. A
   company only ever needs one of the two populated, never both.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.zoho_company_links') AND name = 'zoho_customer_ids_filter')
    ALTER TABLE dbo.zoho_company_links ADD zoho_customer_ids_filter NVARCHAR(MAX) NULL; -- JSON array of Zoho contact_id strings
GO
