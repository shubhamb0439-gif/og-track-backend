/* =============================================================================
   PATCH: Sitara — full address fields on sitara_customers
   =============================================================================
   Run against a tenant that already has 17_module_sitara.sql (+ patch_08's
   city column) applied. Idempotent — safe to re-run.

   Context: only `city` was ever captured; the customer-detail view needs the
   full address (street lines, state, postal code, country) too — populated
   automatically for BigCommerce-synced customers from billing_address, and
   editable for manually-added ones.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'address_line1')
    ALTER TABLE dbo.sitara_customers ADD address_line1 NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'address_line2')
    ALTER TABLE dbo.sitara_customers ADD address_line2 NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'state')
    ALTER TABLE dbo.sitara_customers ADD state NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'postal_code')
    ALTER TABLE dbo.sitara_customers ADD postal_code NVARCHAR(20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'country')
    ALTER TABLE dbo.sitara_customers ADD country NVARCHAR(100) NULL;
GO
