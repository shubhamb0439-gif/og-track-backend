/* =============================================================================
   PATCH: Sitara — mark an order excluded from sales reporting
   =============================================================================
   Run against a tenant that already has 17_module_sitara.sql applied from
   before this column existed. Idempotent — safe to re-run.

   Context: some BigCommerce orders are real checkout tests the merchant ran
   that they can't/won't delete from BigCommerce itself — since the backfill
   re-syncs every order id that still exists there, deleting them locally
   only ever gets them resurrected on the next backfill. This flag lets them
   stay in the system (still visible, still synced) while being excluded
   from GET /dashboard's sales figures.
   ========================================================================== */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'excluded_from_reporting')
    ALTER TABLE dbo.sitara_orders ADD excluded_from_reporting BIT NOT NULL DEFAULT 0;
GO
