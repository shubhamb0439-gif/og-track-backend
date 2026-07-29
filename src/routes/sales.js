const express = require('express');
const router = express.Router();

// ── Row mappers ────────────────────────────────────────────────────────────────
const mapSale = (r) => r && ({
  id: r.id, saleNumber: r.sale_number, customerId: r.customer_id,
  customerPoId: r.customer_po_id,
  saleDate: r.sale_date,
  subtotal: Number(r.subtotal || 0), tax: Number(r.tax || 0), total: Number(r.total || 0),
  isDelivered: !!r.is_delivered, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapSaleItem = (r) => r && ({
  id: r.id, saleId: r.sale_id,
  assemblyUnitId: r.assembly_unit_id, itemId: r.item_id,
  serialNumber: r.serial_number,
  quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total),
});

const mapDelivery = (r) => r && ({
  id: r.id, deliveryNumber: r.delivery_number, saleId: r.sale_id,
  deliveryAddress: r.delivery_address, deliveryLocation: r.delivery_location,
  scheduledDate: r.scheduled_date, deliveredDate: r.delivered_date,
  delivered: !!r.delivered, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Helper: generate next sale number
async function nextSaleNumber(db) {
  const last = await db('sales').orderBy('created_at', 'desc').first();
  if (!last || !last.sale_number) return 'SALE-0001';
  const match = last.sale_number.match(/(\d+)$/);
  const next = match ? parseInt(match[1], 10) + 1 : 1;
  return 'SALE-' + String(next).padStart(4, '0');
}

async function nextDeliveryNumber(db) {
  const last = await db('deliveries').orderBy('created_at', 'desc').first();
  if (!last || !last.delivery_number) return 'DEL-0001';
  const match = last.delivery_number.match(/(\d+)$/);
  const next = match ? parseInt(match[1], 10) + 1 : 1;
  return 'DEL-' + String(next).padStart(4, '0');
}

// ── Sales ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    let q = req.db('sales');
    if (req.query.customerId) q = q.where({ customer_id: req.query.customerId });
    if (req.query.isDelivered !== undefined) q = q.where({ is_delivered: req.query.isDelivered === 'true' ? 1 : 0 });
    const rows = await q.orderBy('sale_date', 'desc');
    res.json(rows.map(mapSale));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const sale = await req.db('sales').where({ id: req.params.id }).first();
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const items = await req.db('sale_items').where({ sale_id: req.params.id });
    // Enrich sale items with serial numbers from mfg_assembly_units
    const enriched = await Promise.all(items.map(async (item) => {
      const unit = await req.db('mfg_assembly_units').where({ id: item.assembly_unit_id }).first();
      return { ...mapSaleItem(item), serialNumber: unit?.serial_number || null };
    }));
    const delivery = await req.db('deliveries').where({ sale_id: req.params.id }).first();
    res.json({ ...mapSale(sale), items: enriched, delivery: delivery ? mapDelivery(delivery) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sales
// Body: { customerId, customerPoId?, saleDate?, tax?, notes,
//         items: [{ assemblyUnitId, unitPrice }] }
router.post('/', async (req, res) => {
  try {
    const { customerId, customerPoId, saleDate, tax, notes, items } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });

    const customer = await req.db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(400).json({ error: 'Customer not found' });

    // Validate each unit exists, is not already sold, and get its item
    for (const item of items) {
      const unit = await req.db('mfg_assembly_units').where({ id: item.assemblyUnitId }).first();
      if (!unit) return res.status(400).json({ error: `Assembly unit ${item.assemblyUnitId} not found` });
      if (unit.sold) return res.status(400).json({ error: `Unit ${unit.serial_number || item.assemblyUnitId} has already been sold` });
    }

    const saleId = 'sale_' + Date.now();
    const saleNumber = await nextSaleNumber(req.db);
    let subtotal = 0;

    await req.db.transaction(async (trx) => {
      for (const item of items) {
        const unit = await trx('mfg_assembly_units').where({ id: item.assemblyUnitId }).first();
        const asm = await trx('mfg_assemblies').where({ id: unit.assembly_id }).first();
        const lineTotal = Number(item.quantity || 1) * Number(item.unitPrice);
        subtotal += lineTotal;

        await trx('sale_items').insert({
          id: 'si_' + Date.now() + Math.random().toString(36).slice(2, 6),
          sale_id: saleId,
          assembly_unit_id: item.assemblyUnitId,
          item_id: asm.product_item_id,
          quantity: item.quantity || 1,
          unit_price: item.unitPrice,
          line_total: lineTotal,
        });

        // Mark the unit as sold
        await trx('mfg_assembly_units').where({ id: item.assemblyUnitId }).update({ sold: 1 });

        // Decrement the product item's stock_sold
        await trx('inv_items').where({ id: asm.product_item_id }).increment('stock_sold', Number(item.quantity || 1));
      }

      const taxAmt = Number(tax || 0);
      const total = subtotal + taxAmt;

      await trx('sales').insert({
        id: saleId, sale_number: saleNumber, customer_id: customerId,
        customer_po_id: customerPoId || null,
        sale_date: saleDate || new Date(),
        subtotal, tax: taxAmt, total,
        is_delivered: 0, notes: notes || null,
        created_by: req.user?.userId || null,
      });

      // Update customer lifetime_value
      const { sum } = await trx('sales').where({ customer_id: customerId }).sum('total as sum').first();
      await trx('customers').where({ id: customerId }).update({ lifetime_value: sum || 0 });
    });

    const saved = await req.db('sales').where({ id: saleId }).first();
    req.io.to(req.company.slug).emit('sales:sale_created', mapSale(saved));
    res.json(mapSale(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.notes !== undefined) updates.notes = b.notes;
    if (b.saleDate !== undefined) updates.sale_date = b.saleDate;
    if (b.customerPoId !== undefined) updates.customer_po_id = b.customerPoId;
    await req.db('sales').where({ id: req.params.id }).update(updates);
    const saved = await req.db('sales').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Sale not found' });
    req.io.to(req.company.slug).emit('sales:sale_updated', mapSale(saved));
    res.json(mapSale(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const sale = await req.db('sales').where({ id: req.params.id }).first();
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    // Unmark all units as sold before deleting
    const saleItems = await req.db('sale_items').where({ sale_id: req.params.id });
    for (const item of saleItems) {
      await req.db('mfg_assembly_units').where({ id: item.assembly_unit_id }).update({ sold: 0 });
      await req.db('inv_items').where({ id: item.item_id }).decrement('stock_sold', Number(item.quantity));
    }

    await req.db('delivery_items')
      .whereIn('sale_item_id', saleItems.map(i => i.id)).delete();
    await req.db('deliveries').where({ sale_id: req.params.id }).delete();
    await req.db('sale_items').where({ sale_id: req.params.id }).delete();
    await req.db('sales').where({ id: req.params.id }).delete();

    // Recompute lifetime value
    const { sum } = await req.db('sales').where({ customer_id: sale.customer_id }).sum('total as sum').first();
    await req.db('customers').where({ id: sale.customer_id }).update({ lifetime_value: sum || 0 });

    req.io.to(req.company.slug).emit('sales:sale_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Deliveries ────────────────────────────────────────────────────────────────

router.get('/deliveries', async (req, res) => {
  try {
    let q = req.db('deliveries');
    if (req.query.delivered !== undefined) q = q.where({ delivered: req.query.delivered === 'true' ? 1 : 0 });
    const rows = await q.orderBy('created_at', 'desc');
    res.json(rows.map(mapDelivery));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sales/:id/delivery — create delivery for a sale
router.post('/:id/delivery', async (req, res) => {
  try {
    const sale = await req.db('sales').where({ id: req.params.id }).first();
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const existing = await req.db('deliveries').where({ sale_id: req.params.id }).first();
    if (existing) return res.status(400).json({ error: 'A delivery already exists for this sale' });

    const { deliveryAddress, deliveryLocation, scheduledDate, notes } = req.body;
    const deliveryNumber = await nextDeliveryNumber(req.db);
    const id = 'del_' + Date.now();

    await req.db('deliveries').insert({
      id, delivery_number: deliveryNumber, sale_id: req.params.id,
      delivery_address: deliveryAddress || null,
      delivery_location: deliveryLocation || null,
      scheduled_date: scheduledDate || null,
      delivered: 0, notes: notes || null,
      created_by: req.user?.userId || null,
    });
    const saved = await req.db('deliveries').where({ id }).first();
    req.io.to(req.company.slug).emit('sales:delivery_created', mapDelivery(saved));
    res.json(mapDelivery(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/sales/deliveries/:id
router.patch('/deliveries/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.deliveryAddress !== undefined) updates.delivery_address = b.deliveryAddress;
    if (b.deliveryLocation !== undefined) updates.delivery_location = b.deliveryLocation;
    if (b.scheduledDate !== undefined) updates.scheduled_date = b.scheduledDate;
    if (b.notes !== undefined) updates.notes = b.notes;
    if (b.delivered !== undefined) {
      updates.delivered = b.delivered ? 1 : 0;
      updates.delivered_date = b.delivered ? new Date() : null;
      // Mirror onto the sale
      const delivery = await req.db('deliveries').where({ id: req.params.id }).first();
      if (delivery) {
        await req.db('sales').where({ id: delivery.sale_id }).update({ is_delivered: b.delivered ? 1 : 0 });
      }
    }
    await req.db('deliveries').where({ id: req.params.id }).update(updates);
    const saved = await req.db('deliveries').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Delivery not found' });
    req.io.to(req.company.slug).emit('sales:delivery_updated', mapDelivery(saved));
    res.json(mapDelivery(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;