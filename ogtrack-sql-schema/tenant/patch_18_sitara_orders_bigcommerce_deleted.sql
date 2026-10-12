/* =============================================================================
   PATCH: sitara_orders — track BigCommerce's own is_deleted flag
   =============================================================================
   Run against sitara_drapes. Idempotent.

   Context: live-confirmed BigCommerce does NOT hard-delete an order when it
   cancels a failed-redirect checkout — it soft-deletes (is_deleted: true on
   the order object), which hides it from the customer's own account/order
   history entirely while a direct admin API lookup by id still returns it
   normally. Our sync only ever stored BigCommerce's status string, never
   this flag, so an order could sit locally as a perfectly healthy
   'awaiting_fulfillment' order — payment matched, everything looking fine —
   while the actual customer sees nothing on BigCommerce's side at all. This
   column makes that state queryable instead of invisible.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.sitara_orders') AND name = 'bigcommerce_deleted')
    ALTER TABLE dbo.sitara_orders ADD bigcommerce_deleted BIT NOT NULL DEFAULT 0;
GO
