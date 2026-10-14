/* =============================================================================
   PATCH: sitara_orders — a real, atomic idempotency key for recovered orders
   =============================================================================
   Run against sitara_drapes. Idempotent.

   Context: the SORD-0457/458 duplicate incident (2026-10-12) was a genuine
   race condition — routes/sitara.js's recoverOrderFromCart() checked for an
   existing order via a plain SELECT (`notes LIKE '%paymentId%'`) before
   INSERTing a new one. That's a check-then-act race, not an atomic
   constraint: the real-time webhook and the scheduled backfill
   (sitaraRazorpayScheduler.js) both call the SAME underlying sync function,
   and if they land close enough together for the same payment, BOTH can
   pass the SELECT check before either has inserted — producing two orders
   for one payment. Only the resulting DATA was cleaned up at the time; this
   is the actual fix for the race itself, which was otherwise still fully
   reproducible.

   recovered_from_payment_id stores the Razorpay payment id directly (not
   buried in free-text notes), with a UNIQUE FILTERED index so SQL Server
   enforces "at most one order per payment id" atomically at the database
   level — the one thing a pre-check SELECT can never guarantee under
   concurrency. Filtered (WHERE ... IS NOT NULL) so every non-recovered
   order (NULL here) is completely unaffected; SQL Server's standard pattern
   for "unique only among non-null values".
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'recovered_from_payment_id')
    ALTER TABLE dbo.sitara_orders ADD recovered_from_payment_id NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'UX_sitara_orders_recovered_from_payment_id')
    CREATE UNIQUE INDEX UX_sitara_orders_recovered_from_payment_id
        ON dbo.sitara_orders(recovered_from_payment_id)
        WHERE recovered_from_payment_id IS NOT NULL;
GO
