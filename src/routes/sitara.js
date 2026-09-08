const express = require('express');
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
  id: r.id, name: r.name, phone: r.phone, email: r.email, source: r.source,
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

const mapOrder = (r) => r && ({
  id: r.id, bigcommerceOrderId: r.bigcommerce_order_id, orderNumber: r.order_number,
  customerId: r.customer_id, status: r.status, total: Number(r.total || 0), source: r.source,
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

const ORDER_STATUSES = [
  'awaiting_fulfillment', 'awaiting_payment', 'partially_shipped',
  'shipped', 'completed', 'cancelled', 'refunded',
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
    const { name, phone, email, source, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const validSource = ['bigcommerce', 'whatsapp', 'instagram', 'manual'].includes(source) ? source : 'manual';
    const id = newId('cust');
    await req.db('sitara_customers').insert({
      id, name, phone: phone || null, email: email || null, source: validSource,
      notes: notes || null, created_by: req.user?.userId || null,
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
async function nextOrderNumber(db) {
  const last = await db('sitara_orders').orderBy('created_at', 'desc').first();
  if (!last || !last.order_number) return 'SORD-0001';
  const match = last.order_number.match(/(\d+)$/);
  const next = match ? parseInt(match[1], 10) + 1 : 1;
  return 'SORD-' + String(next).padStart(4, '0');
}

router.get('/orders', async (req, res) => {
  try {
    let q = req.db('sitara_orders');
    if (req.query.status) q = q.where({ status: req.query.status });
    if (req.query.source) q = q.where({ source: req.query.source });
    const rows = await q.orderBy('created_at', 'desc');
    res.json(rows.map(mapOrder));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await req.db('sitara_orders').where({ id: req.params.id }).first();
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
    const saved = await req.db('sitara_orders').where({ id }).first();
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
    const saved = await req.db('sitara_orders').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('sitara:order_updated', mapOrder(saved));
    res.json(mapOrder(saved));
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
    const recentOrders = await req.db('sitara_orders').orderBy('created_at', 'desc').limit(10);
    const pendingOrders = allOrders.filter((o) => !['completed', 'cancelled', 'refunded'].includes(o.status));

    const products = await req.db('sitara_products').select('stock');
    const stockOnHand = products.reduce((sum, p) => sum + Number(p.stock || 0), 0);

    res.json({
      recentSales: recentOrders.map(mapOrder),
      totalSales,
      totalSalesThisMonth: monthSales,
      orderCount: allOrders.length,
      totalExpenses: 0, // no expense-tracking source yet in Phase 1 — reserved for a later pass
      stockOnHand,
      pendingOrderCount: pendingOrders.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
