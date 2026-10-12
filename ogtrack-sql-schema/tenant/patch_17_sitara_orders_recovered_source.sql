/* =============================================================================
   PATCH: sitara_orders — add 'recovered' as a valid source
   =============================================================================
   Run against an existing tenant DB that already has 17_module_sitara.sql
   applied (sitara_drapes specifically). Idempotent.

   Context: a real, recurring failure mode confirmed live — Razorpay captures
   payment successfully, but BigCommerce's post-payment redirect fails, and
   BigCommerce deletes the order entirely even though the customer paid. The
   payment's own notes (bigc_cart_id) let us recover the real cart contents
   and recreate the order locally — 'recovered' distinguishes this from a
   normal BigCommerce-synced order (source='bigcommerce') and a true manual/
   DM sale (source='manual'), since neither label is accurate for this case.
   ============================================================================= */

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_sitara_orders_source')
    ALTER TABLE dbo.sitara_orders DROP CONSTRAINT CK_sitara_orders_source;
GO
ALTER TABLE dbo.sitara_orders ADD CONSTRAINT CK_sitara_orders_source CHECK (source IN ('bigcommerce','manual','recovered'));
GO
