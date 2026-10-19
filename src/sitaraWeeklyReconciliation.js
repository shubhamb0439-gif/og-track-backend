const ExcelJS = require('exceljs');
const config = require('./config');
const coreDb = require('./db/core');
const { getTenantDbByName } = require('./db/tenantConnections');
const sitaraRoutes = require('./routes/sitara');
const { sendEmail } = require('./utils/email');

/**
 * Weekly Sitara Razorpay-vs-orders reconciliation — automates the manual
 * pull-from-Razorpay / match-against-sitara_orders / build-a-workbook process
 * done by hand 2026-10-19 (which surfaced 5 real orders paid for on Razorpay
 * but never synced into sitara_orders). Runs on an interval, same pattern as
 * sitaraRazorpayScheduler.js, and emails the resulting workbook to
 * config.sitaraWeeklyReconciliation's recipients via the platform's existing
 * no-reply ACS sender (src/utils/email.js) rather than any Sitara-branded
 * sender — this is an internal ops report, not customer-facing mail.
 *
 * Deliberately pulls straight from Razorpay's own API for the report window
 * rather than trusting sitara_razorpay_payments/sitara_orders alone — those
 * tables are themselves populated by the daily backfill's own matching logic,
 * which is exactly what missed the 5 gap orders found manually. Re-deriving
 * the match independently here (by notes.bigc_order_id, same primary-match
 * rule as matchRazorpayPaymentToOrder) means a bug in the daily sync can't
 * also hide from this weekly report.
 */

let pollTimer = null;
let running = false;

async function fetchCapturedPayments({ from, to }) {
  const payments = await sitaraRoutes.listAllRazorpayPayments({ from, to });
  const capturedByBigcId = new Map();
  const capturedWithoutBigcId = [];
  for (const entity of payments) {
    if (entity.status !== 'captured') continue;
    const bigcOrderId = entity.notes?.bigc_order_id;
    const record = {
      razorpayPaymentId: entity.id,
      amount: Number(entity.amount || 0) / 100, // Razorpay amounts are in paise
      email: entity.email || '',
      contact: entity.contact || '',
      createdAt: entity.created_at ? new Date(entity.created_at * 1000) : null,
    };
    if (bigcOrderId) capturedByBigcId.set(String(bigcOrderId), record);
    else capturedWithoutBigcId.push(record);
  }
  return { capturedByBigcId, capturedWithoutBigcId };
}

async function buildWorkbook({ db, capturedByBigcId, fromLabel, toLabel }) {
  const bigcIds = [...capturedByBigcId.keys()];

  const orders = bigcIds.length
    ? await db('sitara_orders')
        .leftJoin('sitara_customers', 'sitara_orders.customer_id', 'sitara_customers.id')
        .whereIn('sitara_orders.bigcommerce_order_id', bigcIds)
        .select(
          'sitara_orders.id as orderId',
          'sitara_orders.bigcommerce_order_id as bcOrderId',
          'sitara_orders.order_number as orderNumber',
          'sitara_orders.total as total',
          'sitara_orders.status as status',
          'sitara_customers.name as customerName',
          'sitara_customers.email as customerEmail',
          'sitara_customers.phone as customerPhone',
          'sitara_customers.city as city',
          'sitara_customers.state as state'
        )
    : [];

  const orderIds = orders.map((o) => o.orderId);
  const items = orderIds.length
    ? await db('sitara_order_items').whereIn('order_id', orderIds).select('order_id', 'product_name', 'quantity')
    : [];
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }

  const foundBigcIds = new Set(orders.map((o) => String(o.bcOrderId)));
  const missingIds = bigcIds.filter((id) => !foundBigcIds.has(id));

  const records = orders.map((o) => {
    const rzp = capturedByBigcId.get(String(o.bcOrderId));
    const productSummary = (itemsByOrder.get(o.orderId) || []).map((it) => `${it.product_name} x${it.quantity}`).join('; ');
    return {
      bcOrderId: o.bcOrderId,
      orderNumber: o.orderNumber,
      customerName: o.customerName || '',
      customerEmail: o.customerEmail || (rzp ? rzp.email : ''),
      customerPhone: o.customerPhone || (rzp ? rzp.contact : ''),
      location: [o.city, o.state].filter(Boolean).join(', '),
      amount: o.total,
      razorpayAmount: rzp ? rzp.amount : '',
      razorpayPaymentId: rzp ? rzp.razorpayPaymentId : '',
      status: o.status,
      products: productSummary,
    };
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`${fromLabel}-${toLabel} Reconciled Orders`);
  sheet.columns = [
    { header: 'BC Order ID', key: 'bcOrderId', width: 12 },
    { header: 'Order Number', key: 'orderNumber', width: 16 },
    { header: 'Customer Name', key: 'customerName', width: 26 },
    { header: 'Customer Email', key: 'customerEmail', width: 30 },
    { header: 'Customer Phone', key: 'customerPhone', width: 16 },
    { header: 'Location (City, State)', key: 'location', width: 26 },
    { header: 'Order Amount (INR)', key: 'amount', width: 16 },
    { header: 'Razorpay Captured Amount (INR)', key: 'razorpayAmount', width: 22 },
    { header: 'Razorpay Payment ID', key: 'razorpayPaymentId', width: 22 },
    { header: 'Order Status', key: 'status', width: 16 },
    { header: 'Products (name x qty)', key: 'products', width: 50 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
  records.sort((a, b) => Number(a.bcOrderId) - Number(b.bcOrderId)).forEach((r) => sheet.addRow(r));
  sheet.autoFilter = { from: 'A1', to: 'K1' };

  const missingSheet = workbook.addWorksheet('Paid but missing from system');
  missingSheet.columns = [
    { header: 'BC Order ID (from Razorpay notes)', key: 'bcOrderId', width: 30 },
    { header: 'Note', key: 'note', width: 70 },
  ];
  missingSheet.getRow(1).font = { bold: true };
  missingSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4CCCC' } };
  missingIds.forEach((id) =>
    missingSheet.addRow({
      bcOrderId: id,
      note: 'Razorpay shows a captured payment referencing this BigCommerce order, but no matching row exists in sitara_orders — the order never synced into our system.',
    })
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, matchedCount: records.length, missingIds, totalCaptured: [...capturedByBigcId.values()].reduce((s, p) => s + p.amount, 0) };
}

async function runWeeklyReport() {
  const to = new Date();
  const from = new Date(to.getTime() - config.sitaraWeeklyReconciliation.periodMs);
  const fromLabel = from.toISOString().slice(0, 10);
  const toLabel = to.toISOString().slice(0, 10);

  const company = await coreDb('companies').where({ slug: 'sitara' }).first();
  if (!company) { console.log('[sitara-weekly-reconciliation] Sitara company not provisioned — skipping.'); return; }
  const db = getTenantDbByName(company.db_name);

  const { capturedByBigcId } = await fetchCapturedPayments({
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
  });

  const { buffer, matchedCount, missingIds, totalCaptured } = await buildWorkbook({ db, capturedByBigcId, fromLabel, toLabel });

  const filename = `Sitara_Reconciliation_${fromLabel}_to_${toLabel}.xlsx`;
  const html = `
    <p>Weekly Sitara Razorpay-vs-orders reconciliation for <strong>${fromLabel} to ${toLabel}</strong>.</p>
    <ul>
      <li>Captured Razorpay payments matched to a real order: <strong>${matchedCount}</strong></li>
      <li>Total captured revenue this week: <strong>₹${totalCaptured.toFixed(2)}</strong></li>
      <li>Captured payments with NO matching order in our system: <strong>${missingIds.length}</strong>${missingIds.length ? ` (BC order IDs: ${missingIds.join(', ')})` : ''}</li>
    </ul>
    <p>Full detail attached.</p>
  `;

  await sendEmail({
    to: config.sitaraWeeklyReconciliation.recipientTo,
    cc: config.sitaraWeeklyReconciliation.recipientCc,
    subject: `Sitara Razorpay Reconciliation — ${fromLabel} to ${toLabel}`,
    html,
    text: html.replace(/<[^>]+>/g, ''),
    attachments: [{ name: filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentInBase64: buffer.toString('base64') }],
  });

  console.log(`[sitara-weekly-reconciliation] sent report ${fromLabel}-${toLabel}: ${matchedCount} matched, ${missingIds.length} missing.`);
}

async function checkAndRun() {
  if (running || !config.email.enabled || !config.razorpay.enabled) return;
  running = true;
  try {
    const state = await coreDb('ai_sitara_weekly_reconciliation_state').where({ id: 'sitara' }).first();
    const lastRunAt = state?.last_run_at ? new Date(state.last_run_at) : null;
    const due = !lastRunAt || Date.now() - lastRunAt.getTime() >= config.sitaraWeeklyReconciliation.periodMs;
    if (!due) return;

    await runWeeklyReport();

    if (state) await coreDb('ai_sitara_weekly_reconciliation_state').where({ id: 'sitara' }).update({ last_run_at: new Date(), updated_at: new Date() });
    else await coreDb('ai_sitara_weekly_reconciliation_state').insert({ id: 'sitara', last_run_at: new Date(), updated_at: new Date() });
  } catch (e) {
    console.error('[sitara-weekly-reconciliation] run failed:', e.message);
  } finally {
    running = false;
  }
}

/** Call once from server.js. No-op if email or Razorpay isn't configured. */
function start() {
  if (!config.email.enabled || !config.razorpay.enabled) {
    console.log('[sitara-weekly-reconciliation] Email or Razorpay not configured — scheduler not started.');
    return;
  }
  if (pollTimer) return;
  checkAndRun().catch((e) => console.error('[sitara-weekly-reconciliation] initial check failed:', e.message));
  pollTimer = setInterval(checkAndRun, config.sitaraWeeklyReconciliation.checkIntervalMs);
  pollTimer.unref?.();
}

module.exports = { start, runWeeklyReport };
