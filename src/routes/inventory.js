const express = require('express');
const router = express.Router();
const { recomputeItemStock, consumeStockFIFO, createLot } = require('../utils/stockLots');

// ── Row mappers ────────────────────────────────────────────────────────────────
const mapVendor = (r) => r && ({
  id: r.id, name: r.name, email: r.email, phone: r.phone,
  address: r.address, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

function stockWarning(item) {
  const stock = Number(item.stock || 0);
  if (item.max_stock != null && stock > Number(item.max_stock)) return 'overstocked';
  if (item.min_stock != null && stock < Number(item.min_stock)) return 'low';
  if (item.reorder_point != null && stock <= Number(item.reorder_point)) return 'reorder';
  return null;
}

const mapItem = (r) => r && ({
  id: r.id,
  name: r.name,
  itemCode: r.item_code,
  group: r.item_group,
  class: r.item_class,
  unit: r.unit,
  stock: Number(r.stock || 0),
  sold: Number(r.sold || 0),
  avgCost: r.avg_cost != null ? Number(r.avg_cost) : null,
  avgLeadTimeDays: r.avg_lead_time_days,
  minStock: r.min_stock != null ? Number(r.min_stock) : null,
  maxStock: r.max_stock != null ? Number(r.max_stock) : null,
  reorderPoint: r.reorder_point != null ? Number(r.reorder_point) : null,
  warning: stockWarning(r),
  notes: r.notes,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPurchase = (r) => r && ({
  id: r.id,
  poNumber: r.po_number,
  vendorId: r.vendor_id,
  status: r.status,
  orderDate: r.order_date,
  expectedDate: r.expected_date,
  receivedDate: r.received_date,
  invoiceNumber: r.invoice_number,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPurchaseItem = (r) => r && ({
  id: r.id,
  purchaseId: r.purchase_id,
  itemId: r.item_id,
  quantityOrdered: Number(r.quantity_ordered),
  quantityReceived: Number(r.quantity_received || 0),
  unitCost: Number(r.unit_cost || 0),
  freightCost: Number(r.freight_cost || 0),
  importCharges: Number(r.import_charges || 0),
  // What this line actually costs per unit once landed — this is what
  // feeds into the item's average cost, matching the real Receipts sheet's
  // Cost -> Import duty/freight -> Total -> Per-unit-cost flow.
  effectiveUnitCost: Number(r.quantity_ordered) > 0
    ? (Number(r.unit_cost || 0) * Number(r.quantity_ordered) + Number(r.freight_cost || 0) + Number(r.import_charges || 0)) / Number(r.quantity_ordered)
    : Number(r.unit_cost || 0),
});

// ── Vendors ───────────────────────────────────────────────────────────────────

router.get('/vendors', async (req, res) => {
  try {
    const rows = await req.db('inv_vendors').orderBy('name', 'asc');
    res.json(rows.map(mapVendor));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/vendors', async (req, res) => {
  try {
    const { name, email, phone, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'ven' + Date.now();
    await req.db('inv_vendors').insert({ id, name, email: email || null, phone: phone || null, address: address || null, notes: notes || null });
    const saved = await req.db('inv_vendors').where({ id }).first();
    req.io.to(req.company.slug).emit('inv:vendor_created', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/vendors/:id', async (req, res) => {
  try {
    const { name, email, phone, address, notes } = req.body;
    const updates = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (notes !== undefined) updates.notes = notes;
    await req.db('inv_vendors').where({ id: req.params.id }).update(updates);
    const saved = await req.db('inv_vendors').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Vendor not found' });
    req.io.to(req.company.slug).emit('inv:vendor_updated', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vendors/:id', async (req, res) => {
  try {
    const inUse = await req.db('inv_purchases').where({ vendor_id: req.params.id }).first();
    if (inUse) return res.status(400).json({ error: 'This vendor has purchase orders on record and cannot be deleted.' });
    await req.db('inv_vendors').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('inv:vendor_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Items ─────────────────────────────────────────────────────────────────────

router.get('/items', async (req, res) => {
  try {
    let q = req.db('inv_items');
    if (req.query.group) q = q.where({ item_group: req.query.group });
    const rows = await q.orderBy('name', 'asc');
    res.json(rows.map(mapItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/items', async (req, res) => {
  try {
    const { name, itemCode, group, itemClass, unit, minStock, maxStock, reorderPoint, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (group && !['part', 'component', 'product'].includes(group)) {
      return res.status(400).json({ error: "group must be 'part', 'component', or 'product'" });
    }
    const id = 'item' + Date.now();
    await req.db('inv_items').insert({
      id, name,
      item_code: itemCode || null,
      item_group: group || 'part',
      item_class: itemClass || null,
      unit: unit || 'pcs',
      min_stock: minStock != null ? minStock : null,
      max_stock: maxStock != null ? maxStock : null,
      reorder_point: reorderPoint != null ? reorderPoint : null,
      notes: notes || null,
    });
    const saved = await req.db('inv_items').where({ id }).first();
    req.io.to(req.company.slug).emit('inv:item_created', mapItem(saved));
    res.json(mapItem(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/items/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.itemCode !== undefined) updates.item_code = b.itemCode;
    if (b.group !== undefined) updates.item_group = b.group;
    if (b.itemClass !== undefined) updates.item_class = b.itemClass;
    if (b.unit !== undefined) updates.unit = b.unit;
    if (b.minStock !== undefined) updates.min_stock = b.minStock;
    if (b.maxStock !== undefined) updates.max_stock = b.maxStock;
    if (b.reorderPoint !== undefined) updates.reorder_point = b.reorderPoint;
    if (b.notes !== undefined) updates.notes = b.notes;
    // Deliberately NOT allowing `stock` to be set directly here — matches
    // the real system's behavior (no "type over the stock count" field).
    // Use POST /items/:id/adjust-stock for manual corrections instead.

    await req.db('inv_items').where({ id: req.params.id }).update(updates);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Item not found' });
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json(mapItem(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/inventory/items/:id/adjust-stock — manual correction
// (physical count, damage, write-off, or entering historical opening stock).
// Positive delta creates a new lot (you supply its cost); negative delta
// consumes existing lots FIFO. Every adjustment is still logged in
// inv_stock_adjustments regardless of direction, for the same audit reason
// as before — this just also keeps the underlying lots consistent now.
router.post('/items/:id/adjust-stock', async (req, res) => {
  try {
    const { delta, reason, unitCost, lotRef } = req.body;
    if (delta == null || isNaN(Number(delta)) || Number(delta) === 0) {
      return res.status(400).json({ error: 'delta is required and must be a non-zero number' });
    }
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if (Number(delta) > 0) {
      await createLot(req.db, {
        itemId: req.params.id,
        lotRef: lotRef || null,
        quantity: Number(delta),
        unitCost: unitCost != null ? Number(unitCost) : (item.avg_cost || 0),
        source: 'manual',
        notes: reason || null,
      });
    } else {
      await consumeStockFIFO(req.db, req.params.id, Math.abs(Number(delta)));
    }

    await req.db('inv_stock_adjustments').insert({
      id: 'adj' + Date.now(),
      item_id: req.params.id,
      delta,
      reason: reason || null,
      created_by: req.user?.userId || null,
    });
    await recomputeItemStock(req.db, req.params.id);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json(mapItem(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/inventory/items/:id/lots — every lot for this item, oldest
// first, so the UI can show exactly what's on hand and at what cost.
router.get('/items/:id/lots', async (req, res) => {
  try {
    const rows = await req.db('inv_stock_lots').where({ item_id: req.params.id }).orderBy('received_date', 'asc').orderBy('created_at', 'asc');
    res.json(rows.map(l => ({
      id: l.id,
      lotRef: l.lot_ref,
      vendorId: l.vendor_id,
      purchaseItemId: l.purchase_item_id,
      quantityReceived: Number(l.quantity_received),
      quantityRemaining: Number(l.quantity_remaining),
      unitCost: Number(l.unit_cost),
      receivedDate: l.received_date,
      source: l.source,
      notes: l.notes,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/inventory/items/:id/issue — general stock consumption
// that ISN'T a manufacturing build (sales, scrap, samples, whatever) —
// matches the real Issues sheet, which includes things sent to customers,
// not just BOM builds. Draws FIFO across lots, same as manufacturing does.
router.post('/items/:id/issue', async (req, res) => {
  try {
    const { quantity, details, issueDate } = req.body;
    if (quantity == null || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity is required and must be positive' });
    }
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const consumed = await consumeStockFIFO(req.db, req.params.id, Number(quantity));

    const issueId = 'iss' + Date.now();
    await req.db('inv_stock_issues').insert({
      id: issueId,
      item_id: req.params.id,
      quantity,
      issue_date: issueDate || new Date(),
      details: details || null,
      created_by: req.user?.userId || null,
    });
    for (const c of consumed) {
      await req.db('inv_stock_issue_lots').insert({
        id: 'isl' + Date.now() + Math.random().toString(36).slice(2, 6),
        issue_id: issueId,
        lot_id: c.lotId,
        quantity: c.quantityConsumed,
      });
    }

    await recomputeItemStock(req.db, req.params.id);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json({ issueId, consumed, item: mapItem(saved) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/items/:id', async (req, res) => {
  try {
    const inUse = await req.db('inv_purchase_items').where({ item_id: req.params.id }).first();
    if (inUse) return res.status(400).json({ error: 'This item appears on a purchase order and cannot be deleted.' });
    const hasLots = await req.db('inv_stock_lots').where({ item_id: req.params.id }).first();
    if (hasLots) return res.status(400).json({ error: 'This item has stock lot history and cannot be deleted.' });
    await req.db('inv_stock_adjustments').where({ item_id: req.params.id }).delete();
    await req.db('inv_items').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('inv:item_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Purchases ─────────────────────────────────────────────────────────────────

router.get('/purchases', async (req, res) => {
  try {
    let q = req.db('inv_purchases');
    if (req.query.status) q = q.where({ status: req.query.status });
    const rows = await q.orderBy('order_date', 'desc');
    res.json(rows.map(mapPurchase));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/inventory/purchases/:id — includes line items
router.get('/purchases/:id', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const items = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    res.json({ ...mapPurchase(purchase), items: items.map(mapPurchaseItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/inventory/purchases — create a PO with line items.
// Body: { poNumber, vendorId, orderDate, expectedDate, notes, lines: [{itemId, quantityOrdered, unitCost}] }
router.post('/purchases', async (req, res) => {
  try {
    const { poNumber, vendorId, orderDate, expectedDate, notes, lines } = req.body;
    if (!poNumber || !vendorId) return res.status(400).json({ error: 'poNumber and vendorId are required' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });

    const vendor = await req.db('inv_vendors').where({ id: vendorId }).first();
    if (!vendor) return res.status(400).json({ error: 'Vendor not found' });

    const id = 'po' + Date.now();
    await req.db('inv_purchases').insert({
      id, po_number: poNumber, vendor_id: vendorId,
      status: 'pending',
      order_date: orderDate || new Date(),
      expected_date: expectedDate || null,
      notes: notes || null,
      created_by: req.user?.userId || null,
    });
    for (const line of lines) {
      if (!line.itemId || !line.quantityOrdered) continue;
      await req.db('inv_purchase_items').insert({
        id: 'poi' + Date.now() + Math.random().toString(36).slice(2, 6),
        purchase_id: id,
        item_id: line.itemId,
        quantity_ordered: line.quantityOrdered,
        unit_cost: line.unitCost || 0,
        freight_cost: line.freightCost || 0,
        import_charges: line.importCharges || 0,
      });
    }
    const saved = await req.db('inv_purchases').where({ id }).first();
    const items = await req.db('inv_purchase_items').where({ purchase_id: id });
    req.io.to(req.company.slug).emit('inv:purchase_created', mapPurchase(saved));
    res.json({ ...mapPurchase(saved), items: items.map(mapPurchaseItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/inventory/purchases/:id — edit status/notes/dates (not line items)
router.patch('/purchases/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.status !== undefined) updates.status = b.status;
    if (b.notes !== undefined) updates.notes = b.notes;
    if (b.expectedDate !== undefined) updates.expected_date = b.expectedDate;
    if (b.invoiceNumber !== undefined) updates.invoice_number = b.invoiceNumber;
    await req.db('inv_purchases').where({ id: req.params.id }).update(updates);
    const saved = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Purchase not found' });
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(saved));
    res.json(mapPurchase(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/inventory/purchases/:id/receive — mark the whole PO as
// received: for every line, whatever's still outstanding (ordered - already
// received) gets added to that item's stock, quantity_received is set to
// quantity_ordered, and the item's avg_cost is recomputed from ALL of its
// received purchase lines (weighted average), not just this one. This is
// Phase 2's receiving model — full-PO receipt only; partial per-line
// receiving would be a natural follow-up enhancement.
router.post('/purchases/:id/receive', async (req, res) => {
  try {
    const { invoiceNumber, lotRefs } = req.body; // lotRefs: optional { [purchaseItemId]: "23NOV0001" }
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'received') return res.status(400).json({ error: 'This purchase is already marked received.' });
    if (purchase.status === 'cancelled') return res.status(400).json({ error: 'This purchase was cancelled.' });

    const lines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const touchedItemIds = new Set();

    for (const line of lines) {
      const outstanding = Number(line.quantity_ordered) - Number(line.quantity_received || 0);
      if (outstanding > 0) {
        await req.db('inv_purchase_items').where({ id: line.id }).update({ quantity_received: line.quantity_ordered });

        // Landed cost per unit for THIS line only — freight/import spread
        // across its own quantity. This becomes the lot's fixed cost,
        // never blended with any other lot's cost.
        const landedUnitCost = (Number(line.unit_cost || 0) * Number(line.quantity_ordered)
          + Number(line.freight_cost || 0) + Number(line.import_charges || 0)) / Number(line.quantity_ordered);

        await createLot(req.db, {
          itemId: line.item_id,
          lotRef: (lotRefs && lotRefs[line.id]) || `${purchase.po_number}-${line.id.slice(-6)}`,
          vendorId: purchase.vendor_id,
          purchaseItemId: line.id,
          quantity: outstanding,
          unitCost: landedUnitCost,
          receivedDate: new Date(),
          source: 'purchase',
        });
        touchedItemIds.add(line.item_id);
      }
    }

    for (const itemId of touchedItemIds) {
      await recomputeItemStock(req.db, itemId);
      const savedItem = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(savedItem));
    }

    await req.db('inv_purchases').where({ id: req.params.id }).update({
      status: 'received', received_date: new Date(), updated_at: new Date(),
      ...(invoiceNumber !== undefined ? { invoice_number: invoiceNumber } : {}),
    });
    const saved = await req.db('inv_purchases').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(saved));
    res.json(mapPurchase(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/purchases/:id', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'received') {
      return res.status(400).json({ error: 'A received purchase has already affected stock and cannot be deleted — cancel future orders instead.' });
    }
    await req.db('inv_purchase_items').where({ purchase_id: req.params.id }).delete();
    await req.db('inv_purchases').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('inv:purchase_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;