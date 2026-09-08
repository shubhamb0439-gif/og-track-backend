/**
 * One-time (or re-runnable) backfill for BigCommerce orders that existed
 * BEFORE the store/order/created and store/order/statusUpdated webhooks
 * were created — those only fire for new events going forward, so anything
 * already in BigCommerce needs to be pulled in explicitly, once.
 *
 * Reuses the EXACT same sync logic the live webhook uses
 * (src/routes/sitara.js's syncBigCommerceOrder) rather than a second copy of
 * it — same customer-matching, same status mapping, same upsert behavior.
 * Safe to re-run: syncBigCommerceOrder already upserts by bigcommerce_order_id.
 *
 * Run from the backend folder:
 *   node scripts/backfillBigCommerceOrders.js <company-slug>
 */
require('dotenv').config();
const config = require('../src/config');
const coreDb = require('../src/db/core');
const { getTenantDbByName } = require('../src/db/tenantConnections');
const sitaraRoutes = require('../src/routes/sitara');

// syncBigCommerceOrder expects a socket.io instance to broadcast to — there's
// no live server here, so this is a harmless no-op stand-in.
const fakeIo = { to: () => ({ emit: () => {} }) };

async function run() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: node scripts/backfillBigCommerceOrders.js <company-slug>');
    process.exit(1);
  }
  if (!config.bigcommerce.enabled) {
    console.error('BigCommerce is not configured (BIGCOMMERCE_STORE_HASH / BIGCOMMERCE_ACCESS_TOKEN missing).');
    process.exit(1);
  }

  const company = await coreDb('companies').where({ slug }).first();
  if (!company) {
    console.error(`No company found for slug "${slug}".`);
    process.exit(1);
  }
  const db = getTenantDbByName(company.db_name);

  console.log('Listing existing BigCommerce orders...');
  const orderIds = await sitaraRoutes.listAllBigCommerceOrderIds();
  console.log(`Found ${orderIds.length} order(s). Syncing...`);

  let succeeded = 0;
  let failed = 0;
  for (const id of orderIds) {
    try {
      await sitaraRoutes.syncBigCommerceOrder(db, fakeIo, slug, id);
      succeeded += 1;
      console.log(`  synced order ${id}`);
    } catch (e) {
      failed += 1;
      console.error(`  FAILED order ${id}:`, e.message);
    }
  }
  console.log(`Done. ${succeeded} synced, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Backfill failed:', e); process.exit(1); });
