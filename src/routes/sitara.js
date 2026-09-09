const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const router = express.Router();

// ── Row mappers ──────────────────────────────────────────────────────────────
const mapWeaver = (r) => r && ({
  id: r.id, name: r.name, contactName: r.contact_name, phone: r.phone, email: r.email,
  notes: r.notes, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapVendor = (r) => r && ({
  id: r.id, name: r.name, contactName: r.contact_name, phone: r.phone, email: r.email,
  notes: r.notes, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapCustomer = (r) => r && ({
  id: r.id, name: r.name, phone: r.phone, email: r.email, source: r.source, city: r.city,
  bigcommerceCustomerId: r.bigcommerce_customer_id, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapProduct = (r) => r && ({
  id: r.id, name: r.name, sku: r.sku, vendorId: r.vendor_id, weaverId: r.weaver_id,
  stock: Number(r.stock || 0), unit: r.unit, bigcommerceProductId: r.bigcommerce_product_id,
  notes: r.notes, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPO = (r) => r && ({
  id: r.id, poNumber: r.po_number, vendorId: r.vendor_id, status: r.status,
  orderDate: r.order_date, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPOItem = (r) => r && ({
  id: r.id, purchaseOrderId: r.purchase_order_id, productId: r.product_id,
  quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total || 0),
});

// customerName/customerCity are flat fields (not nested customer: {...}) —
// simplest for the frontend to render directly without a second lookup.
// Both are null when there's no linked customer (e.g. an order synced before
// the guest-checkout fix) or the caller didn't join sitara_customers in.
const mapOrder = (r) => r && ({
  id: r.id, bigcommerceOrderId: r.bigcommerce_order_id, orderNumber: r.order_number,
  customerId: r.customer_id, customerName: r.customer_name ?? null, customerCity: r.customer_city ?? null,
  status: r.status, total: Number(r.total || 0), source: r.source,
  statusChangedAt: r.status_changed_at, flagged: !!r.flagged, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapOrderItem = (r) => r && ({
  id: r.id, orderId: r.order_id, productId: r.product_id, productName: r.product_name,
  quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total || 0),
});

function newId(prefix) {
  return `${prefix}_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

// Base query for reading sitara_orders with the linked customer's name/city
// already joined in — every read path that ends in mapOrder(...) should
// start from this, not a bare db('sitara_orders'), so customerName/customerCity
// are always populated rather than silently null. Writes (insert/update)
// still go through the plain table name directly, not this query.
function ordersQuery(db) {
  return db('sitara_orders')
    .leftJoin('sitara_customers', 'sitara_orders.customer_id', 'sitara_customers.id')
    .select('sitara_orders.*', 'sitara_customers.name as customer_name', 'sitara_customers.city as customer_city');
}

// Mirrors BigCommerce's own order status list — see BC_STATUS_MAP below for
// the human-string -> this-enum mapping used when syncing a BigCommerce order in.
const ORDER_STATUSES = [
  'incomplete', 'pending', 'awaiting_payment', 'awaiting_fulfillment', 'awaiting_shipment',
  'awaiting_pickup', 'partially_shipped', 'shipped', 'completed', 'cancelled', 'declined',
  'refunded', 'partially_refunded', 'disputed', 'manual_verification_required', 'verified',
];

// ── Weavers ──────────────────────────────────────────────────────────────────
router.get('/weavers', async (req, res) => {
  try {
    const rows = await req.db('sitara_weavers').orderBy('name', 'asc');
    res.json(rows.map(mapWeaver));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/weavers', async (req, res) => {
  try {
    const { name, contactName, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = newId('weaver');
    await req.db('sitara_weavers').insert({
      id, name, contact_name: contactName || null, phone: phone || null, email: email || null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('sitara_weavers').where({ id }).first();
    req.io.to(req.company.slug).emit('sitara:weaver_created', mapWeaver(saved));
    res.json(mapWeaver(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/weavers/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.contactName !== undefined) updates.contact_name = b.contactName;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.email !== undefined) updates.email = b.email;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('sitara_weavers').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sitara_weavers').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Weaver not found' });
    req.io.to(req.company.slug).emit('sitara:weaver_updated', mapWeaver(saved));
    res.json(mapWeaver(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/weavers/:id', async (req, res) => {
  try {
    await req.db('sitara_weavers').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('sitara:weaver_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Vendors ──────────────────────────────────────────────────────────────────
router.get('/vendors', async (req, res) => {
  try {
    const rows = await req.db('sitara_vendors').orderBy('name', 'asc');
    res.json(rows.map(mapVendor));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/vendors', async (req, res) => {
  try {
    const { name, contactName, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = newId('vendor');
    await req.db('sitara_vendors').insert({
      id, name, contact_name: contactName || null, phone: phone || null, email: email || null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('sitara_vendors').where({ id }).first();
    req.io.to(req.company.slug).emit('sitara:vendor_created', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/vendors/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.contactName !== undefined) updates.contact_name = b.contactName;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.email !== undefined) updates.email = b.email;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('sitara_vendors').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sitara_vendors').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Vendor not found' });
    req.io.to(req.company.slug).emit('sitara:vendor_updated', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vendors/:id', async (req, res) => {
  try {
    await req.db('sitara_vendors').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('sitara:vendor_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customers ────────────────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const rows = await req.db('sitara_customers').orderBy('name', 'asc');
    res.json(rows.map(mapCustomer));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sitara/customers
// Body: { name, phone?, email?, source ('bigcommerce'|'whatsapp'|'instagram'|'manual'), notes? }
// Manual customer creation — the source dropdown the frontend needs, per the
// spec ("source of customer can vary from whatsapp/instagram/bigcommerce").
// Real BigCommerce customers are upserted separately by the webhook handler
// (Phase 2), not through this endpoint.
router.post('/customers', async (req, res) => {
  try {
    const { name, phone, email, source, city, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const validSource = ['bigcommerce', 'whatsapp', 'instagram', 'manual'].includes(source) ? source : 'manual';
    const id = newId('cust');
    await req.db('sitara_customers').insert({
      id, name, phone: phone || null, email: email || null, source: validSource,
      city: city || null, notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('sitara_customers').where({ id }).first();
    req.io.to(req.company.slug).emit('sitara:customer_created', mapCustomer(saved));
    res.json(mapCustomer(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/customers/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.email !== undefined) updates.email = b.email;
    if (b.city !== undefined) updates.city = b.city;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('sitara_customers').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sitara_customers').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Customer not found' });
    req.io.to(req.company.slug).emit('sitara:customer_updated', mapCustomer(saved));
    res.json(mapCustomer(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/customers/:id', async (req, res) => {
  try {
    await req.db('sitara_customers').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('sitara:customer_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Products (inventory) ──────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const rows = await req.db('sitara_products').orderBy('name', 'asc');
    res.json(rows.map(mapProduct));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/products', async (req, res) => {
  try {
    const { name, sku, vendorId, weaverId, stock, unit, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = newId('prod');
    await req.db('sitara_products').insert({
      id, name, sku: sku || null, vendor_id: vendorId || null, weaver_id: weaverId || null,
      stock: Number(stock || 0), unit: unit || 'pcs', notes: notes || null,
      created_by: req.user?.userId || null,
    });
    const saved = await req.db('sitara_products').where({ id }).first();
    req.io.to(req.company.slug).emit('sitara:product_created', mapProduct(saved));
    res.json(mapProduct(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/products/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.sku !== undefined) updates.sku = b.sku;
    if (b.vendorId !== undefined) updates.vendor_id = b.vendorId;
    if (b.weaverId !== undefined) updates.weaver_id = b.weaverId;
    if (b.stock !== undefined) updates.stock = Number(b.stock);
    if (b.unit !== undefined) updates.unit = b.unit;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('sitara_products').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sitara_products').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Product not found' });
    req.io.to(req.company.slug).emit('sitara:product_updated', mapProduct(saved));
    res.json(mapProduct(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/products/:id', async (req, res) => {
  try {
    await req.db('sitara_products').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('sitara:product_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Purchase orders (vendor-linked) ───────────────────────────────────────────
async function nextPoNumber(db) {
  const last = await db('sitara_purchase_orders').orderBy('created_at', 'desc').first();
  if (!last || !last.po_number) return 'SPO-0001';
  const match = last.po_number.match(/(\d+)$/);
  const next = match ? parseInt(match[1], 10) + 1 : 1;
  return 'SPO-' + String(next).padStart(4, '0');
}

router.get('/purchase-orders', async (req, res) => {
  try {
    const rows = await req.db('sitara_purchase_orders').orderBy('order_date', 'desc');
    res.json(rows.map(mapPO));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/purchase-orders/:id', async (req, res) => {
  try {
    const po = await req.db('sitara_purchase_orders').where({ id: req.params.id }).first();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const items = await req.db('sitara_purchase_order_items').where({ purchase_order_id: req.params.id });
    res.json({ ...mapPO(po), items: items.map(mapPOItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sitara/purchase-orders
// Body: { vendorId, orderDate?, notes?, items: [{ productId, quantity, unitPrice }] }
// The "manual Add Purchase button" the spec explicitly asks for — every
// purchase order here is created this way, there's no separate auto-generated
// path (unlike sitara_orders, which BigCommerce also feeds in Phase 2).
router.post('/purchase-orders', async (req, res) => {
  try {
    const { vendorId, orderDate, notes, items } = req.body;
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    const vendor = await req.db('sitara_vendors').where({ id: vendorId }).first();
    if (!vendor) return res.status(400).json({ error: 'Vendor not found' });

    const id = newId('spo');
    const poNumber = await nextPoNumber(req.db);
    await req.db('sitara_purchase_orders').insert({
      id, po_number: poNumber, vendor_id: vendorId, order_date: orderDate || new Date(),
      notes: notes || null, created_by: req.user?.userId || null,
    });
    for (const item of items) {
      const lineTotal = Number(item.quantity) * Number(item.unitPrice || 0);
      await req.db('sitara_purchase_order_items').insert({
        id: newId('spoi'), purchase_order_id: id, product_id: item.productId,
        quantity: item.quantity, unit_price: item.unitPrice || 0, line_total: lineTotal,
      });
    }
    const saved = await req.db('sitara_purchase_orders').where({ id }).first();
    const savedItems = await req.db('sitara_purchase_order_items').where({ purchase_order_id: id });
    req.io.to(req.company.slug).emit('sitara:po_created', mapPO(saved));
    res.json({ ...mapPO(saved), items: savedItems.map(mapPOItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/purchase-orders/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.status !== undefined) updates.status = b.status;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('sitara_purchase_orders').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sitara_purchase_orders').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Purchase order not found' });
    req.io.to(req.company.slug).emit('sitara:po_updated', mapPO(saved));
    res.json(mapPO(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/purchase-orders/:id', async (req, res) => {
  try {
    await req.db('sitara_purchase_order_items').where({ purchase_order_id: req.params.id }).delete();
    await req.db('sitara_purchase_orders').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('sitara:po_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders (BigCommerce-fed in Phase 2 + manual entry) ────────────────────────

// BigCommerce's own order status strings (its Order Statuses reference) ->
// this table's snake_case enum. Verify this list against a real webhook
// payload once BigCommerce is actually wired up — mapped from documented
// status names, not yet confirmed against this specific store's live data.
const BC_STATUS_MAP = {
  'Incomplete': 'incomplete',
  'Pending': 'pending',
  'Awaiting Payment': 'awaiting_payment',
  'Awaiting Fulfillment': 'awaiting_fulfillment',
  'Awaiting Shipment': 'awaiting_shipment',
  'Awaiting Pickup': 'awaiting_pickup',
  'Partially Shipped': 'partially_shipped',
  'Shipped': 'shipped',
  'Completed': 'completed',
  'Cancelled': 'cancelled',
  'Declined': 'declined',
  'Refunded': 'refunded',
  'Partially Refunded': 'partially_refunded',
  'Disputed': 'disputed',
  'Manual Verification Required': 'manual_verification_required',
  'Verified': 'verified',
};
function mapBigCommerceStatus(bcStatus) {
  return BC_STATUS_MAP[bcStatus] || 'awaiting_fulfillment';
}

function bigcommerceApiHeaders() {
  return { 'X-Auth-Token': config.bigcommerce.accessToken, Accept: 'application/json' };
}

async function fetchBigCommerceOrder(orderId) {
  const res = await fetch(`https://api.bigcommerce.com/stores/${config.bigcommerce.storeHash}/v2/orders/${orderId}`, {
    headers: bigcommerceApiHeaders(),
  });
  if (!res.ok) throw new Error(`BigCommerce order fetch failed (${res.status})`);
  return res.json();
}

async function fetchBigCommerceOrderProducts(orderId) {
  const res = await fetch(`https://api.bigcommerce.com/stores/${config.bigcommerce.storeHash}/v2/orders/${orderId}/products`, {
    headers: bigcommerceApiHeaders(),
  });
  if (!res.ok) throw new Error(`BigCommerce order products fetch failed (${res.status})`);
  return res.json();
}

/**
 * Pulls one order (by its BigCommerce id) from BigCommerce's API and
 * upserts it into sitara_orders/sitara_order_items. Called from the webhook
 * on both order/created and order/statusUpdated — always re-fetches the
 * full order rather than trusting webhook payload fields, since the
 * webhook body itself only carries the id, not the order contents.
 */
async function syncBigCommerceOrder(db, io, companySlug, bcOrderId) {
  const bcOrder = await fetchBigCommerceOrder(bcOrderId);
  const bcProducts = await fetchBigCommerceOrderProducts(bcOrderId);
  const mappedStatus = mapBigCommerceStatus(bcOrder.status);

  // Match/create the customer. BigCommerce uses customer_id === 0 for a
  // GUEST checkout (not "no customer") — confirmed live: a real order had
  // customer_id: 0 but full name/email sitting right in billing_address.
  // 0 is falsy in JS, so a plain `if (bcOrder.customer_id)` check silently
  // skipped customer creation for every guest order — that was the bug.
  // Registered customers key off bigcommerce_customer_id; guests (no real BC
  // customer id to key off) key off email instead, so repeat guest orders
  // from the same email still link to one customer record.
  let customerId = null;
  const billing = bcOrder.billing_address || {};
  const customerName = [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim();
  const bcCustomerId = bcOrder.customer_id ? String(bcOrder.customer_id) : null;

  if (bcCustomerId || billing.email || customerName) {
    let customer = bcCustomerId
      ? await db('sitara_customers').where({ bigcommerce_customer_id: bcCustomerId }).first()
      : (billing.email ? await db('sitara_customers').where({ email: billing.email, source: 'bigcommerce' }).first() : null);
    if (!customer) {
      const id = newId('cust');
      await db('sitara_customers').insert({
        id,
        name: customerName || (bcCustomerId ? `Customer ${bcCustomerId}` : 'Guest'),
        phone: billing.phone || null,
        email: billing.email || null,
        source: 'bigcommerce',
        city: billing.city || null,
        bigcommerce_customer_id: bcCustomerId,
      });
      customer = await db('sitara_customers').where({ id }).first();
    }
    customerId = customer.id;
  }

  const existing = await db('sitara_orders').where({ bigcommerce_order_id: String(bcOrderId) }).first();
  const statusChanged = !existing || existing.status !== mappedStatus;

  let orderId = existing?.id;
  if (!existing) {
    orderId = newId('sord');
    await db('sitara_orders').insert({
      id: orderId, bigcommerce_order_id: String(bcOrderId), order_number: `BC-${bcOrderId}`,
      customer_id: customerId, status: mappedStatus, total: Number(bcOrder.total_inc_tax || 0),
      source: 'bigcommerce', status_changed_at: new Date(),
    });
  } else {
    await db('sitara_orders').where({ id: orderId }).update({
      customer_id: customerId, status: mappedStatus, total: Number(bcOrder.total_inc_tax || 0),
      status_changed_at: statusChanged ? new Date() : existing.status_changed_at,
      flagged: statusChanged ? 0 : existing.flagged,
      updated_at: new Date(),
    });
    await db('sitara_order_items').where({ order_id: orderId }).delete();
  }

  for (const p of (bcProducts || [])) {
    // BigCommerce product names can contain HTML (confirmed live:
    // "Moonlit  <em>Jamdani</em>") — strip it before storing.
    const cleanName = String(p.name || '').replace(/<[^>]+>/g, '').trim() || 'Item';

    // Match/create the catalog product by BigCommerce's product id. Starts
    // at stock: 0 — this only ever discovers a product THROUGH an order, it
    // has no way to know the product's actual current stock (a real
    // catalog/inventory sync from BigCommerce is still out of scope) —
    // correct it manually in Stocks > Inventory once you notice it appear.
    let productId = null;
    if (p.product_id) {
      const bcProductId = String(p.product_id);
      let product = await db('sitara_products').where({ bigcommerce_product_id: bcProductId }).first();
      if (!product) {
        const id = newId('prod');
        await db('sitara_products').insert({
          id, name: cleanName, sku: p.sku || null, stock: 0, unit: 'pcs',
          bigcommerce_product_id: bcProductId,
        });
        product = await db('sitara_products').where({ id }).first();
      }
      productId = product.id;

      // Decrement stock ONLY the first time this order is ever synced — a
      // status-update webhook re-syncs the SAME order later (that's the
      // `existing` branch above, which already deleted+will re-insert these
      // same order_items), so gating on `!existing` here is what stops a
      // second webhook for the same order from decrementing stock twice.
      if (!existing) {
        await db('sitara_products').where({ id: productId }).decrement('stock', Number(p.quantity || 1));
      }
    }

    await db('sitara_order_items').insert({
      id: newId('soi'), order_id: orderId, product_id: productId,
      product_name: cleanName, quantity: Number(p.quantity || 1),
      unit_price: Number(p.price_inc_tax || 0), line_total: Number(p.total_inc_tax || 0),
    });
  }

  const saved = await ordersQuery(db).where({ 'sitara_orders.id': orderId }).first();
  io.to(companySlug).emit(existing ? 'sitara:order_updated' : 'sitara:order_created', mapOrder(saved));
}

function verifyBigCommerceWebhook(req) {
  if (!config.bigcommerce.webhookSecret) {
    console.warn('[sitara] BIGCOMMERCE_WEBHOOK_SECRET not set — skipping webhook verification.');
    return true;
  }
  const provided = req.headers['x-sitara-webhook-secret'];
  if (!provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(config.bigcommerce.webhookSecret));
  } catch {
    return false; // length mismatch etc. — definitely not a match
  }
}

// POST /api/:slug/sitara/bigcommerce/webhook
// BigCommerce doesn't sign webhook bodies with a computed HMAC — its real
// mechanism is a custom header attached when the webhook subscription is
// created (BigCommerce V3 Webhooks API's "headers" field). Create the
// subscription with a header named exactly X-Sitara-Webhook-Secret, value =
// whatever BIGCOMMERCE_WEBHOOK_SECRET is set to.
router.post('/bigcommerce/webhook', async (req, res) => {
  res.sendStatus(200); // ack fast — same reasoning as the WhatsApp webhook
  try {
    if (!config.bigcommerce.enabled) return;
    if (!verifyBigCommerceWebhook(req)) {
      console.error('[sitara] rejected a BigCommerce webhook POST with an invalid/missing secret header.');
      return;
    }
    const { scope, data } = req.body || {};
    if (!scope || !data?.id) return;
    if (scope.startsWith('store/order/')) {
      await syncBigCommerceOrder(req.db, req.io, req.company.slug, data.id);
    }
  } catch (e) {
    console.error('[sitara] BigCommerce webhook processing failed:', e);
  }
});

// GET /api/:slug/sitara/bigcommerce/debug/:orderId — returns BigCommerce's
// RAW order + line-items response, unmodified. Temporary diagnostic only
// (not referenced by any other code), used to fix field-mapping bugs
// against real data instead of guessing from documentation — remove once
// the mapping issues are resolved and confirmed correct.
router.get('/bigcommerce/debug/:orderId', async (req, res) => {
  if (!config.bigcommerce.enabled) return res.status(503).json({ error: 'BigCommerce is not configured.' });
  try {
    const order = await fetchBigCommerceOrder(req.params.orderId);
    const products = await fetchBigCommerceOrderProducts(req.params.orderId);
    res.json({ order, products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function listAllBigCommerceOrderIds() {
  const ids = [];
  let page = 1;
  const limit = 250;
  for (;;) {
    const res = await fetch(
      `https://api.bigcommerce.com/stores/${config.bigcommerce.storeHash}/v2/orders?limit=${limit}&page=${page}`,
      { headers: bigcommerceApiHeaders() }
    );
    if (res.status === 204) break; // BigCommerce returns 204 (no body) past the last page
    if (!res.ok) throw new Error(`BigCommerce order list failed (${res.status}): ${await res.text()}`);
    const orders = await res.json();
    if (!orders.length) break;
    orders.forEach((o) => ids.push(o.id));
    if (orders.length < limit) break;
    page += 1;
  }
  return ids;
}

// In-memory only (one entry per company slug) — this is a rare, one-off
// admin operation, not a real job queue; a server restart losing progress
// mid-backfill is fine, just re-run it (syncBigCommerceOrder upserts, so a
// partial re-run never double-counts).
const backfillStatus = new Map();

// POST /api/:slug/sitara/bigcommerce/backfill
// One-time (or re-runnable) catch-up for orders that existed in BigCommerce
// BEFORE the webhooks were created — those only fire for new events going
// forward. Reuses syncBigCommerceOrder. Fire-and-forget: acks immediately
// and runs in the background (same "ack fast, process after" pattern as the
// webhook above) — a real store's order history can easily take longer than
// any HTTP client's own timeout (confirmed live: Postman's cloud agent caps
// at 30s). Poll GET /bigcommerce/backfill/status for progress instead.
router.post('/bigcommerce/backfill', async (req, res) => {
  if (!config.bigcommerce.enabled) return res.status(503).json({ error: 'BigCommerce is not configured.' });
  const slug = req.company.slug;
  if (backfillStatus.get(slug)?.status === 'running') {
    return res.status(409).json({ error: 'A backfill is already running for this company — check GET /bigcommerce/backfill/status.' });
  }
  backfillStatus.set(slug, { status: 'running', startedAt: new Date() });
  res.json({ started: true, message: 'Running in the background — poll GET /bigcommerce/backfill/status for progress.' });

  const db = req.db;
  const io = req.io;
  (async () => {
    try {
      const orderIds = await listAllBigCommerceOrderIds();
      let succeeded = 0;
      const failures = [];
      for (const id of orderIds) {
        try {
          await syncBigCommerceOrder(db, io, slug, id);
          succeeded += 1;
        } catch (e) {
          failures.push({ id, error: e.message });
        }
      }
      backfillStatus.set(slug, { status: 'completed', totalFound: orderIds.length, succeeded, failed: failures.length, failures, finishedAt: new Date() });
    } catch (e) {
      backfillStatus.set(slug, { status: 'failed', error: e.message, finishedAt: new Date() });
    }
  })();
});

router.get('/bigcommerce/backfill/status', (req, res) => {
  res.json(backfillStatus.get(req.company.slug) || { status: 'never_run' });
});

async function nextOrderNumber(db) {
  const last = await db('sitara_orders').orderBy('created_at', 'desc').first();
  if (!last || !last.order_number) return 'SORD-0001';
  const match = last.order_number.match(/(\d+)$/);
  const next = match ? parseInt(match[1], 10) + 1 : 1;
  return 'SORD-' + String(next).padStart(4, '0');
}

router.get('/orders', async (req, res) => {
  try {
    let q = ordersQuery(req.db);
    if (req.query.status) q = q.where({ 'sitara_orders.status': req.query.status });
    if (req.query.source) q = q.where({ 'sitara_orders.source': req.query.source });
    const rows = await q.orderBy('sitara_orders.created_at', 'desc');
    res.json(rows.map(mapOrder));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await ordersQuery(req.db).where({ 'sitara_orders.id': req.params.id }).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const items = await req.db('sitara_order_items').where({ order_id: req.params.id });
    res.json({ ...mapOrder(order), items: items.map(mapOrderItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sitara/orders — manual order entry (e.g. a GPay/DM sale
// that never went through BigCommerce checkout). bigcommerce_order_id stays
// NULL, source is always 'manual' here — the webhook handler (Phase 2) is
// the only thing that ever sets source:'bigcommerce'.
// Body: { customerId?, status?, notes?, items: [{ productId?, productName, quantity, unitPrice }] }
router.post('/orders', async (req, res) => {
  try {
    const { customerId, status, notes, items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const id = newId('sord');
    const orderNumber = await nextOrderNumber(req.db);
    let total = 0;
    for (const item of items) total += Number(item.quantity) * Number(item.unitPrice || 0);

    await req.db('sitara_orders').insert({
      id, order_number: orderNumber, customer_id: customerId || null,
      status: ORDER_STATUSES.includes(status) ? status : 'awaiting_fulfillment',
      total, source: 'manual', notes: notes || null, created_by: req.user?.userId || null,
    });
    for (const item of items) {
      const lineTotal = Number(item.quantity) * Number(item.unitPrice || 0);
      await req.db('sitara_order_items').insert({
        id: newId('soi'), order_id: id, product_id: item.productId || null,
        product_name: item.productName || 'Item', quantity: item.quantity,
        unit_price: item.unitPrice || 0, line_total: lineTotal,
      });
    }
    const saved = await ordersQuery(req.db).where({ 'sitara_orders.id': id }).first();
    const savedItems = await req.db('sitara_order_items').where({ order_id: id });
    req.io.to(req.company.slug).emit('sitara:order_created', mapOrder(saved));
    res.json({ ...mapOrder(saved), items: savedItems.map(mapOrderItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/sitara/orders/:id/status
// Body: { status }
// The one status-change path for every order regardless of source — Phase 2
// extends this SAME handler to also push the change to BigCommerce when
// order.bigcommerce_order_id is set, rather than adding a separate endpoint.
// BigCommerce's write API keys order status by a NUMERIC status_id, not the
// string — these are BigCommerce's documented DEFAULT status ids, but a
// store can have custom statuses with different ids. VERIFY this against
// GET https://api.bigcommerce.com/stores/{store_hash}/v2/order_statuses for
// this specific store before relying on it; don't trust this list blindly.
const BC_STATUS_ID = {
  incomplete: 0, pending: 1, shipped: 2, partially_shipped: 3, refunded: 4,
  cancelled: 5, declined: 6, awaiting_payment: 7, awaiting_pickup: 8,
  awaiting_shipment: 9, completed: 10, awaiting_fulfillment: 11,
  manual_verification_required: 12, disputed: 13, partially_refunded: 14,
};

async function pushStatusToBigCommerce(bcOrderId, status) {
  const statusId = BC_STATUS_ID[status];
  if (statusId === undefined) throw new Error(`No known BigCommerce status_id for "${status}" — verify BC_STATUS_ID against this store's real order statuses.`);
  const res = await fetch(`https://api.bigcommerce.com/stores/${config.bigcommerce.storeHash}/v2/orders/${bcOrderId}`, {
    method: 'PUT',
    headers: { ...bigcommerceApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_id: statusId }),
  });
  if (!res.ok) throw new Error(`BigCommerce order status push failed (${res.status}): ${await res.text()}`);
}

router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }
    const order = await req.db('sitara_orders').where({ id: req.params.id }).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await req.db('sitara_orders').where({ id: req.params.id }).update({
      status, status_changed_at: new Date(), flagged: 0, updated_at: new Date(),
    });
    const saved = await ordersQuery(req.db).where({ 'sitara_orders.id': req.params.id }).first();
    req.io.to(req.company.slug).emit('sitara:order_updated', mapOrder(saved));

    // Push to BigCommerce for a BigCommerce-sourced order — best-effort: a
    // failure here must never undo the local status change (the local DB is
    // the source of truth for this request), just surface it clearly so the
    // user knows to retry/investigate rather than assuming it round-tripped.
    let bigcommerceSyncError = null;
    if (order.bigcommerce_order_id && config.bigcommerce.enabled) {
      try {
        await pushStatusToBigCommerce(order.bigcommerce_order_id, status);
      } catch (e) {
        console.error(`[sitara] failed to push status to BigCommerce for order ${req.params.id}:`, e.message);
        bigcommerceSyncError = e.message;
      }
    }

    res.json({ ...mapOrder(saved), bigcommerceSyncError });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const allOrders = await req.db('sitara_orders').select('id', 'total', 'status', 'created_at');
    const totalSales = allOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const monthSales = allOrders
      .filter((o) => new Date(o.created_at) >= monthStart)
      .reduce((sum, o) => sum + Number(o.total || 0), 0);
    const recentOrders = await ordersQuery(req.db).orderBy('sitara_orders.created_at', 'desc').limit(10);
    const pendingOrders = allOrders.filter((o) => !['completed', 'cancelled', 'refunded'].includes(o.status));

    const products = await req.db('sitara_products').select('stock');
    const stockOnHand = products.reduce((sum, p) => sum + Number(p.stock || 0), 0);

    // Best-sellers — grouped by product_name (not product_id) since a
    // BigCommerce line item without a matched catalog product still has a
    // real name and should still count; joining on product_id alone would
    // silently drop those.
    const topProducts = await req.db('sitara_order_items')
      .select('product_name')
      .sum('quantity as totalQuantity')
      .sum('line_total as totalRevenue')
      .groupBy('product_name')
      .orderBy('totalQuantity', 'desc')
      .limit(10);

    // Region/location breakdown — grouped by the linked customer's city.
    // Orders with no linked customer or no city on file are excluded rather
    // than lumped into a misleading "unknown" bucket.
    const topRegions = await req.db('sitara_orders')
      .join('sitara_customers', 'sitara_orders.customer_id', 'sitara_customers.id')
      .whereNotNull('sitara_customers.city')
      .select('sitara_customers.city as city')
      .count('sitara_orders.id as orderCount')
      .sum('sitara_orders.total as revenue')
      .groupBy('sitara_customers.city')
      .orderBy('revenue', 'desc')
      .limit(10);

    res.json({
      recentSales: recentOrders.map(mapOrder),
      totalSales,
      totalSalesThisMonth: monthSales,
      orderCount: allOrders.length,
      totalExpenses: 0, // no expense-tracking source yet in Phase 1 — reserved for a later pass
      stockOnHand,
      pendingOrderCount: pendingOrders.length,
      topProducts: topProducts.map((p) => ({
        productName: p.product_name,
        totalQuantity: Number(p.totalQuantity || 0),
        totalRevenue: Number(p.totalRevenue || 0),
      })),
      topRegions: topRegions.map((r) => ({
        city: r.city,
        orderCount: Number(r.orderCount || 0),
        revenue: Number(r.revenue || 0),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exposed as a property on the router (not a separate named export) so
// `require('./routes/sitara')` still works exactly as every other route file
// expects (a bare Express router) — scripts/backfillBigCommerceOrders.js is
// the one place that needs this function directly, reusing the exact same
// sync logic the webhook uses rather than a second copy of it.
router.syncBigCommerceOrder = syncBigCommerceOrder;
router.listAllBigCommerceOrderIds = listAllBigCommerceOrderIds;

module.exports = router;
