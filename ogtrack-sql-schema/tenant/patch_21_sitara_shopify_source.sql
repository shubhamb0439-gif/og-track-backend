/* =============================================================================
   PATCH: sitara_customers / sitara_orders — allow 'shopify' as a source value
   =============================================================================
   Run against sitara_drapes. Idempotent.

   Context: patch_20 added the shopify_order_id/shopify_customer_id/
   shopify_product_id columns, but both tables' `source` columns still have a
   CHECK constraint from 17_module_sitara.sql/patch_17 listing only the
   BigCommerce-era values — live-confirmed via the Shopify backfill's first
   real run (2026-11-03): every one of 8 real orders failed with
   "INSERT statement conflicted with the CHECK constraint
   CK_sitara_customers_source" before this was caught. Same drop-and-recreate
   pattern as patch_17_sitara_orders_recovered_source.sql.
   ============================================================================= */

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_sitara_customers_source')
    ALTER TABLE dbo.sitara_customers DROP CONSTRAINT CK_sitara_customers_source;
GO

ALTER TABLE dbo.sitara_customers ADD CONSTRAINT CK_sitara_customers_source
    CHECK (source IN ('bigcommerce','whatsapp','instagram','manual','shopify'));
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_sitara_orders_source')
    ALTER TABLE dbo.sitara_orders DROP CONSTRAINT CK_sitara_orders_source;
GO

ALTER TABLE dbo.sitara_orders ADD CONSTRAINT CK_sitara_orders_source
    CHECK (source IN ('bigcommerce','manual','recovered','shopify'));
GO
