/* =============================================================================
   PATCH: Sitara customers — add city column
   =============================================================================
   Run against an existing tenant DB that already has 17_module_sitara.sql
   applied. Idempotent — safe to re-run.

   Context: "from which place the orders are coming" — the customer's
   location, populated from BigCommerce's billing_address.city at sync time
   (src/routes/sitara.js's syncBigCommerceOrder). Nullable — manually-added
   customers won't have this unless entered.
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.sitara_customers')
      AND name = 'city'
)
    ALTER TABLE dbo.sitara_customers ADD city NVARCHAR(100) NULL;
GO
