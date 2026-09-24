require('dotenv').config();
const coreDb = require('../src/db/core');
const { getTenantDbByName } = require('../src/db/tenantConnections');

(async () => {
  try {
    const company = await coreDb('companies').where({ slug: 'sitara' }).first();
    const db = getTenantDbByName(company.db_name);

    // Same customer + same total appearing more than once among counted (real-sale) statuses
    const REAL_SALE_STATUSES = ['awaiting_fulfillment','awaiting_shipment','awaiting_pickup','partially_shipped','shipped','completed','verified'];
    const counted = await db('sitara_orders').whereIn('status', REAL_SALE_STATUSES)
      .select('id', 'bigcommerce_order_id', 'customer_id', 'total', 'created_at', 'order_number');
    console.log('Counted (real-sale-status) orders:', counted.length);
    console.log('Sum of their totals:', counted.reduce((s, o) => s + Number(o.total || 0), 0));

    const byCustomerTotal = {};
    for (const o of counted) {
      const key = o.customer_id + '|' + o.total;
      (byCustomerTotal[key] = byCustomerTotal[key] || []).push(o);
    }
    const suspects = Object.values(byCustomerTotal).filter(arr => arr.length > 1);
    console.log('Same customer+total appearing more than once (possible real-world duplicate orders):', suspects.length, 'groups');
    console.log(JSON.stringify(suspects, null, 2));

    // Full list of counted orders for manual cross-check against BigCommerce
    console.log('Full counted order list (id, bc_order_id, order_number, total, created_at):');
    console.log(counted.map(o => `${o.order_number} (bc:${o.bigcommerce_order_id}) total=${o.total} created=${o.created_at}`).join('\n'));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit(0);
  }
})();
