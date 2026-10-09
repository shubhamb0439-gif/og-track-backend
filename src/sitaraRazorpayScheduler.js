const config = require('./config');
const coreDb = require('./db/core');
const { getTenantDbByName } = require('./db/tenantConnections');
const sitaraRoutes = require('./routes/sitara');

/**
 * Scheduled re-sync of Sitara's Razorpay payments against Razorpay's own API
 * — the actual source of truth — on a recurring interval, same pattern as
 * emailMonitor.js's poller. Exists because Razorpay's webhook delivery to
 * this server is confirmed NOT fully reliable (live-verified 2026-10-08: 4
 * real captured payments never arrived via webhook at all for 10-26 days,
 * and one never got its "captured" follow-up after an initial "authorized"
 * webhook — both only surfaced by manually running the existing backfill
 * endpoint). Running it on a timer instead of only on-demand means a missed
 * webhook self-heals within one interval instead of silently staying wrong
 * until someone happens to notice a number doesn't match.
 *
 * Reuses routes/sitara.js's listAllRazorpayPayments/syncRazorpayPayment
 * directly (exported from that file for exactly this reason) rather than a
 * second copy of the Razorpay sync logic.
 */

let pollTimer = null;
let running = false;

async function runBackfill() {
  if (running || !config.razorpay.enabled) return;
  running = true;
  try {
    const company = await coreDb('companies').where({ slug: 'sitara' }).first();
    if (!company) return; // Sitara's own company row isn't provisioned yet — nothing to sync
    const db = await getTenantDbByName(company.db_name);
    const io = require('./aida/jobs/jobRunner').getIo();

    const payments = await sitaraRoutes.listAllRazorpayPayments();
    let succeeded = 0;
    const failures = [];
    for (const entity of payments) {
      try {
        await sitaraRoutes.syncRazorpayPayment(db, io, 'sitara', entity);
        succeeded += 1;
      } catch (e) {
        failures.push({ id: entity.id, error: e.message });
      }
    }
    console.log(`[sitara-razorpay-scheduler] synced ${succeeded}/${payments.length} payments` + (failures.length ? `, ${failures.length} failed` : ''));
    if (failures.length) console.error('[sitara-razorpay-scheduler] failures:', JSON.stringify(failures));
  } catch (e) {
    console.error('[sitara-razorpay-scheduler] run failed:', e.message);
  } finally {
    running = false;
  }
}

/** Call once from server.js, next to the other pollers. No-op if Razorpay isn't configured. */
function start() {
  if (!config.razorpay.enabled) {
    console.log('[sitara-razorpay-scheduler] Razorpay not configured — scheduler not started.');
    return;
  }
  if (pollTimer) return;
  runBackfill().catch((e) => console.error('[sitara-razorpay-scheduler] initial run failed:', e.message));
  pollTimer = setInterval(runBackfill, config.razorpay.backfillIntervalMs);
  pollTimer.unref?.();
}

module.exports = { start };
