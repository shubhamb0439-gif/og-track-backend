/* =============================================================================
   PATCH: sitara_orders / sitara_customers / sitara_products — Shopify id columns
   =============================================================================
   Run against sitara_drapes. Idempotent.

   Context: Sitara is being connected to Shopify as a second order source
   alongside the existing BigCommerce integration (same pattern as
   bigcommerce_order_id/bigcommerce_customer_id/bigcommerce_product_id) —
   Shopify has its own separate id space for orders, customers, and products,
   so each needs its own nullable id column rather than being shoehorned into
   the BigCommerce ones. `source` on both sitara_orders and sitara_customers
   already accepts a new 'shopify' value with no schema change needed there.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'shopify_order_id')
    ALTER TABLE dbo.sitara_orders ADD shopify_order_id NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'UX_sitara_orders_shopify_order_id')
    CREATE UNIQUE INDEX UX_sitara_orders_shopify_order_id
        ON dbo.sitara_orders(shopify_order_id)
        WHERE shopify_order_id IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_customers') AND name = 'shopify_customer_id')
    ALTER TABLE dbo.sitara_customers ADD shopify_customer_id NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_products') AND name = 'shopify_product_id')
    ALTER TABLE dbo.sitara_products ADD shopify_product_id NVARCHAR(100) NULL;
GO
