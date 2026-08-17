const express = require('express');
const router = express.Router();
const { recomputeItemStock, consumeStockFIFO, createLot } = require('../utils/stockLots');

// ── Row mappers ────────────────────────────────────────────────────────────────
const mapVendor = (r) => r && ({
  id: r.id, vendorCode: r.vendor_code, name: r.name, legalName: r.legal_name,
  vendorGroup: r.vendor_group, contactName: r.contact_name,
  email: r.email, phone: r.phone, address: r.address, currency: r.currency,
  ratingPrice: r.rating_price != null ? Number(r.rating_price) : null,
  ratingQuality: r.rating_quality != null ? Number(r.rating_quality) : null,
  ratingLeadTime: r.rating_lead_time != null ? Number(r.rating_lead_time) : null,
  ratingAverage: [r.rating_price, r.rating_quality, r.rating_lead_time]
    .filter(v => v != null).length
    ? [r.rating_price, r.rating_quality, r.rating_lead_time]
        .filter(v => v != null)
        .reduce((a, b) => a + Number(b), 0) /
      [r.rating_price, r.rating_quality, r.rating_lead_time].filter(v => v != null).length
    : null,
  notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

function stockAlert(item) {
  const stock = Number(item.stock || 0);
  const min = Number(item.stock_min || 0);
  const reorder = Number(item.stock_reorder || 0);
  if (min > 0 && stock < min) return 'critical';
  if (reorder > 0 && stock <= reorder) return 'reorder';
  return null;
}

const mapItem = (r) => r && ({
  id: r.id, itemCode: r.item_code, name: r.name, displayName: r.display_name,
  unit: r.unit, itemGroup: r.item_group, itemClass: r.item_class,
  stock: Number(r.stock || 0), stockSold: Number(r.stock_sold || 0),
  stockMin: Number(r.stock_min || 0), stockMax: Number(r.stock_max || 0),
  stockReorder: Number(r.stock_reorder || 0),
  avgCost: r.avg_cost != null ? Number(r.avg_cost) : null,
  costMin: r.cost_min != null ? Number(r.cost_min) : null,
  costMax: r.cost_max != null ? Number(r.cost_max) : null,
  serialTracked: !!r.serial_tracked,
  alert: stockAlert(r),
  notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPurchase = (r) => r && ({
  id: r.id, poNumber: r.po_number, vendorId: r.vendor_id, status: r.status,
  orderDate: r.order_date, expectedDate: r.expected_date,
  receivedDate: r.received_date, invoiceNumber: r.invoice_number,
  notes: r.notes, createdBy: r.created_by,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPurchaseItem = (r) => r && ({
  id: r.id, purchaseId: r.purchase_id, itemId: r.item_id,
  vendorItemCode: r.vendor_item_code,
  quantityOrdered: Number(r.quantity_ordered),
  quantityReceived: Number(r.quantity_received || 0),
  unitCost: Number(r.unit_cost || 0),
  freightCost: Number(r.freight_cost || 0),
  importCharges: Number(r.import_charges || 0),
  leadTimeDays: r.lead_time_days != null ? Number(r.lead_time_days) : null,
  effectiveUnitCost: Number(r.quantity_ordered) > 0
    ? (Number(r.unit_cost || 0) * Number(r.quantity_ordered)
        + Number(r.freight_cost || 0) + Number(r.import_charges || 0))
      / Number(r.quantity_ordered)
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
    const { vendorCode, name, legalName, vendorGroup, contactName, email, phone,
      address, currency, ratingPrice, ratingQuality, ratingLeadTime, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'ven_' + Date.now();
    await req.db('inv_vendors').insert({
      id, vendor_code: vendorCode || null, name, legal_name: legalName || null,
      vendor_group: vendorGroup || null, contact_name: contactName || null,
      email: email || null, phone: phone || null, address: address || null,
      currency: currency || 'INR',
      rating_price: ratingPrice != null ? ratingPrice : null,
      rating_quality: ratingQuality != null ? ratingQuality : null,
      rating_lead_time: ratingLeadTime != null ? ratingLeadTime : null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('inv_vendors').where({ id }).first();
    req.io.to(req.company.slug).emit('inv:vendor_created', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/vendors/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.vendorCode !== undefined) updates.vendor_code = b.vendorCode;
    if (b.name !== undefined) updates.name = b.name;
    if (b.legalName !== undefined) updates.legal_name = b.legalName;
    if (b.vendorGroup !== undefined) updates.vendor_group = b.vendorGroup;
    if (b.contactName !== undefined) updates.contact_name = b.contactName;
    if (b.email !== undefined) updates.email = b.email;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.address !== undefined) updates.address = b.address;
    if (b.currency !== undefined) updates.currency = b.currency;
    if (b.ratingPrice !== undefined) updates.rating_price = b.ratingPrice;
    if (b.ratingQuality !== undefined) updates.rating_quality = b.ratingQuality;
    if (b.ratingLeadTime !== undefined) updates.rating_lead_time = b.ratingLeadTime;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('inv_vendors').where({ id: req.params.id }).update(updates);
    const saved = await req.db('inv_vendors').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Vendor not found' });
    req.io.to(req.company.slug).emit('inv:vendor_updated', mapVendor(saved));
    res.json(mapVendor(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vendors/:id', async (req, res) => {
  try {
    const vendor = await req.db('inv_vendors').where({ id: req.params.id }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Real, received stock traced to this vendor is meaningful history —
    // block on that rather than on merely having a purchase order on file.
    const receivedLots = await req.db('inv_stock_lots').where({ vendor_id: req.params.id }).andWhere('quantity_received', '>', 0).first();
    if (receivedLots) {
      const item = await req.db('inv_items').where({ id: receivedLots.item_id }).first();
      return res.status(400).json({ error: `This vendor still has received stock (lot ${receivedLots.lot_ref || receivedLots.id} for "${item?.name || receivedLots.item_id}") and cannot be deleted. Consider archiving it instead.` });
    }

    // Any zero-quantity lots (edge case) and pending/never-received purchase
    // orders for this vendor are harmless leftovers — clean those up so the
    // delete can actually succeed instead of blocking forever.
    const purchases = await req.db('inv_purchases').where({ vendor_id: req.params.id });
    for (const p of purchases) {
      const lines = await req.db('inv_purchase_items').where({ purchase_id: p.id });
      const anyReceived = lines.some(l => Number(l.quantity_received || 0) > 0);
      if (anyReceived) return res.status(400).json({ error: `Purchase "${p.po_number || p.id}" for this vendor has received items and cannot be cleaned up automatically. Delete or reassign that purchase first.` });
    }
    for (const p of purchases) {
      const lineIds = (await req.db('inv_purchase_items').where({ purchase_id: p.id })).map(l => l.id);
      if (lineIds.length) await req.db('inv_stock_lots').whereIn('purchase_item_id', lineIds).delete();
      await req.db('inv_purchase_items').where({ purchase_id: p.id }).delete();
    }
    await req.db('inv_purchases').where({ vendor_id: req.params.id }).delete();
    await req.db('inv_stock_lots').where({ vendor_id: req.params.id }).delete();

    await req.db('inv_vendors').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('inv:vendor_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Items ─────────────────────────────────────────────────────────────────────

router.get('/items', async (req, res) => {
  try {
    let q = req.db('inv_items');
    if (req.query.group) q = q.where({ item_group: req.query.group });
    if (req.query.alerts === 'true') {
      // Only return items that are below min or at reorder level
      q = q.whereRaw('(stock_min > 0 AND stock < stock_min) OR (stock_reorder > 0 AND stock <= stock_reorder)');
    }
    const rows = await q.orderBy('name', 'asc');
    res.json(rows.map(mapItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/items/:id', async (req, res) => {
  try {
    const row = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Item not found' });
    res.json(mapItem(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/items', async (req, res) => {
  try {
    const { itemCode, name, displayName, unit, itemGroup, itemClass,
      stockMin, stockMax, stockReorder, serialTracked, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'item_' + Date.now();
    await req.db('inv_items').insert({
      id, item_code: itemCode || null, name, display_name: displayName || null,
      unit: unit || 'pcs', item_group: itemGroup || null, item_class: itemClass || null,
      stock_min: stockMin != null ? stockMin : 0,
      stock_max: stockMax != null ? stockMax : 0,
      stock_reorder: stockReorder != null ? stockReorder : 0,
      serial_tracked: serialTracked ? 1 : 0,
      notes: notes || null, created_by: req.user?.userId || null,
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
    if (b.itemCode !== undefined) updates.item_code = b.itemCode;
    if (b.name !== undefined) updates.name = b.name;
    if (b.displayName !== undefined) updates.display_name = b.displayName;
    if (b.unit !== undefined) updates.unit = b.unit;
    if (b.itemGroup !== undefined) updates.item_group = b.itemGroup;
    if (b.itemClass !== undefined) updates.item_class = b.itemClass;
    if (b.stockMin !== undefined) updates.stock_min = b.stockMin;
    if (b.stockMax !== undefined) updates.stock_max = b.stockMax;
    if (b.stockReorder !== undefined) updates.stock_reorder = b.stockReorder;
    if (b.serialTracked !== undefined) updates.serial_tracked = b.serialTracked ? 1 : 0;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('inv_items').where({ id: req.params.id }).update(updates);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Item not found' });
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json(mapItem(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/items/:id', async (req, res) => {
  try {
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Block only on real, meaningful history — not on merely having once
    // appeared on a purchase order line. A pending/never-received purchase
    // line has no downstream consequence and gets cleaned up automatically
    // below instead of blocking the delete outright.
    const soldAsProduct = await req.db('sale_items').where({ item_id: req.params.id }).first();
    if (soldAsProduct) return res.status(400).json({ error: 'This item has sales history and cannot be deleted.' });

    const usedInBom = await req.db('mfg_boms').where({ product_item_id: req.params.id }).first();
    if (usedInBom) return res.status(400).json({ error: `This item is the product of BOM "${usedInBom.name}" and cannot be deleted. Delete that BOM first.` });

    // Only count component usage in BOMs that still exist — mfg_bom_lines
    // rows are supposed to be deleted along with their BOM, but check
    // defensively rather than assume that cascade always ran cleanly.
    const usedAsComponent = await req.db('mfg_bom_lines')
      .where({ component_item_id: req.params.id })
      .whereExists(function () { this.select('*').from('mfg_boms').whereRaw('mfg_boms.id = mfg_bom_lines.bom_id'); })
      .first();
    if (usedAsComponent) return res.status(400).json({ error: 'This item is used as a component in a BOM and cannot be deleted.' });

    const usedInAssembly = await req.db('mfg_assemblies').where({ product_item_id: req.params.id }).whereNot({ status: 'reversed' }).first();
    if (usedInAssembly) return res.status(400).json({ error: 'This item has been built via an active assembly and cannot be deleted.' });

    // Only count component consumption from assemblies that are still
    // active — a reversed assembly's items rows are supposed to be deleted
    // during reversal, but check defensively (joined against the assembly's
    // current status) in case an assembly got stuck in a bad state before
    // that fix, rather than trusting leftover rows are never present.
    const consumedInAssembly = await req.db('mfg_assembly_items')
      .where({ component_item_id: req.params.id })
      .whereExists(function () {
        this.select('*').from('mfg_assemblies')
          .whereRaw('mfg_assemblies.id = mfg_assembly_items.assembly_id')
          .whereNot({ status: 'reversed' });
      })
      .first();
    if (consumedInAssembly) return res.status(400).json({ error: 'This item has been consumed in an active assembly and cannot be deleted.' });

    const orderedByCustomer = await req.db('customer_purchase_order_items').where({ item_id: req.params.id }).first();
    if (orderedByCustomer) return res.status(400).json({ error: 'This item appears on a customer purchase order and cannot be deleted.' });

    // Real, received stock is meaningful history — block on that.
    const receivedLots = await req.db('inv_stock_lots').where({ item_id: req.params.id }).andWhere('quantity_received', '>', 0).first();
    if (receivedLots) {
      const sourceLabel = { purchase: 'a purchase order', assembly: 'a manufacturing assembly', manual: 'a manual stock adjustment' }[receivedLots.source] || 'stock history';
      return res.status(400).json({ error: `This item still has received stock from ${sourceLabel} (lot ${receivedLots.lot_ref || receivedLots.id}) and cannot be deleted. Consider archiving it instead.` });
    }

    // Anything left at this point is harmless leftovers from pending/
    // never-received purchase lines, zero-quantity stock lots, adjustments,
    // and issues — clean those up so the delete can actually succeed.
    const purchaseLineIds = (await req.db('inv_purchase_items').where({ item_id: req.params.id })).map(l => l.id);
    if (purchaseLineIds.length) {
      await req.db('inv_stock_lots').whereIn('purchase_item_id', purchaseLineIds).delete();
      await req.db('inv_purchase_items').whereIn('id', purchaseLineIds).delete();
    }
    await req.db('inv_stock_lots').where({ item_id: req.params.id }).delete();
    await req.db('inv_stock_issues').where({ item_id: req.params.id }).delete();
    await req.db('inv_stock_adjustments').where({ item_id: req.params.id }).delete();
    await req.db('inv_items').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('inv:item_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/items/:id/lots', async (req, res) => {
  try {
    const rows = await req.db('inv_stock_lots')
      .where({ item_id: req.params.id })
      .orderBy('received_date', 'asc').orderBy('created_at', 'asc');
    res.json(rows.map(l => ({
      id: l.id, lotRef: l.lot_ref, vendorId: l.vendor_id,
      purchaseItemId: l.purchase_item_id,
      quantityReceived: Number(l.quantity_received),
      quantityRemaining: Number(l.quantity_remaining),
      unitCost: Number(l.unit_cost),
      receivedDate: l.received_date, source: l.source, notes: l.notes,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        itemId: req.params.id, lotRef: lotRef || null, quantity: Number(delta),
        unitCost: unitCost != null ? Number(unitCost) : (item.avg_cost || 0),
        source: 'manual', notes: reason || null,
      });
    } else {
      await consumeStockFIFO(req.db, req.params.id, Math.abs(Number(delta)));
    }
    await req.db('inv_stock_adjustments').insert({
      id: 'adj_' + Date.now(), item_id: req.params.id,
      delta, reason: reason || null, created_by: req.user?.userId || null,
    });
    await recomputeItemStock(req.db, req.params.id);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json(mapItem(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/items/:id/issue', async (req, res) => {
  try {
    const { quantity, details, issueDate } = req.body;
    if (quantity == null || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity is required and must be positive' });
    }
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const consumed = await consumeStockFIFO(req.db, req.params.id, Number(quantity));
    const issueId = 'iss_' + Date.now();
    await req.db('inv_stock_issues').insert({
      id: issueId, item_id: req.params.id, quantity,
      issue_date: issueDate || new Date(), details: details || null,
      created_by: req.user?.userId || null,
    });
    for (const c of consumed) {
      await req.db('inv_stock_issue_lots').insert({
        id: 'isl_' + Date.now() + Math.random().toString(36).slice(2, 6),
        issue_id: issueId, lot_id: c.lotId, quantity: c.quantityConsumed,
      });
    }
    await recomputeItemStock(req.db, req.params.id);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json({ issueId, consumed, item: mapItem(saved) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Purchases ─────────────────────────────────────────────────────────────────

router.get('/purchases', async (req, res) => {
  try {
    let q = req.db('inv_purchases');
    if (req.query.status) q = q.where({ status: req.query.status });
    if (req.query.vendorId) q = q.where({ vendor_id: req.query.vendorId });
    const rows = await q.orderBy('order_date', 'desc');
    res.json(rows.map(mapPurchase));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/inventory/purchases/all-items — bulk fetch every purchase's line
// items in ONE query, grouped by purchase_id. Used by the Purchases list page to
// populate its line-items cache in a single request instead of firing one fetch
// per purchase order (which, with hundreds/thousands of real POs, caused the list
// to visibly re-render/flicker repeatedly as each individual fetch resolved).
router.get('/purchases/all-items', async (req, res) => {
  try {
    const items = await req.db('inv_purchase_items');
    const byPurchase = {};
    for (const item of items) {
      if (!byPurchase[item.purchase_id]) byPurchase[item.purchase_id] = [];
      byPurchase[item.purchase_id].push(mapPurchaseItem(item));
    }
    res.json(byPurchase);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/purchases/:id', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const items = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    res.json({ ...mapPurchase(purchase), items: items.map(mapPurchaseItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/purchases', async (req, res) => {
  try {
    const { poNumber, vendorId, orderDate, expectedDate, invoiceNumber, notes, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
    const vendor = await req.db('inv_vendors').where({ id: vendorId }).first();
    if (!vendor) return res.status(400).json({ error: 'Vendor not found' });

    const id = 'po_' + Date.now();
    await req.db('inv_purchases').insert({
      id, po_number: poNumber || null, vendor_id: vendorId, status: 'pending',
      order_date: orderDate || new Date(), expected_date: expectedDate || null,
      invoice_number: invoiceNumber || null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    for (const line of lines) {
      if (!line.itemId || !line.quantityOrdered) continue;
      await req.db('inv_purchase_items').insert({
        id: 'poi_' + Date.now() + Math.random().toString(36).slice(2, 6),
        purchase_id: id, item_id: line.itemId,
        vendor_item_code: line.vendorItemCode || null,
        quantity_ordered: line.quantityOrdered,
        unit_cost: line.unitCost || 0,
        freight_cost: line.freightCost || 0,
        import_charges: line.importCharges || 0,
        lead_time_days: line.leadTimeDays || null,
      });
    }
    const saved = await req.db('inv_purchases').where({ id }).first();
    const items = await req.db('inv_purchase_items').where({ purchase_id: id });
    req.io.to(req.company.slug).emit('inv:purchase_created', mapPurchase(saved));
    res.json({ ...mapPurchase(saved), items: items.map(mapPurchaseItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/purchases/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.poNumber !== undefined) updates.po_number = b.poNumber || null;
    if (b.vendorId !== undefined) updates.vendor_id = b.vendorId || null;
    if (b.orderDate !== undefined) updates.order_date = b.orderDate;
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

router.post('/purchases/:id/receive', async (req, res) => {
  try {
    const { invoiceNumber, lotRefs } = req.body;
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'received') return res.status(400).json({ error: 'Already received.' });
    if (purchase.status === 'cancelled') return res.status(400).json({ error: 'Purchase was cancelled.' });

    const lines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const touchedItemIds = new Set();

    // Receiving updates the line, creates its lot, and marks the purchase
    // received together — if any step fails partway (e.g. a transient DB
    // disconnect), the whole receipt rolls back instead of leaving a purchase
    // marked "received" with a missing stock lot (the exact drift that
    // required a manual reconciliation across 874 items previously).
    await req.db.transaction(async (trx) => {
      for (const line of lines) {
        const outstanding = Number(line.quantity_ordered) - Number(line.quantity_received || 0);
        if (outstanding > 0) {
          await trx('inv_purchase_items').where({ id: line.id }).update({ quantity_received: line.quantity_ordered });
          const landedUnitCost = (Number(line.unit_cost || 0) * Number(line.quantity_ordered)
            + Number(line.freight_cost || 0) + Number(line.import_charges || 0))
            / Number(line.quantity_ordered);
          await createLot(trx, {
            itemId: line.item_id,
            lotRef: (lotRefs && lotRefs[line.id]) || `${purchase.po_number}-${line.id.slice(-6)}`,
            vendorId: purchase.vendor_id, purchaseItemId: line.id,
            quantity: outstanding, unitCost: landedUnitCost,
            receivedDate: new Date(), source: 'purchase',
          });
          touchedItemIds.add(line.item_id);
        }
      }
      for (const itemId of touchedItemIds) {
        await recomputeItemStock(trx, itemId);
      }
      await trx('inv_purchases').where({ id: req.params.id }).update({
        status: 'received', received_date: new Date(), updated_at: new Date(),
        ...(invoiceNumber !== undefined ? { invoice_number: invoiceNumber } : {}),
      });
    });

    for (const itemId of touchedItemIds) {
      const savedItem = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(savedItem));
    }
    const saved = await req.db('inv_purchases').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(saved));
    res.json(mapPurchase(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /purchases/:id/receive-lines — per-line partial receiving, driven by
// the Edit Purchase modal's Not Received / Partially Received / Fully
// Received controls (with a % slider for the partial case). Unlike the older
// /receive endpoint (which always force-completes every outstanding line),
// this only advances each line to the quantityReceived the caller specifies,
// and only creates a lot for the newly-received delta on that line.
// Body: { lines: [{ purchaseItemId, quantityReceived }] }
router.post('/purchases/:id/receive-lines', async (req, res) => {
  try {
    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines is required' });
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'cancelled') return res.status(400).json({ error: 'Purchase was cancelled.' });

    const existingLines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const touchedItemIds = new Set();

    // Same atomicity guarantee as /receive above: line update, lot
    // creation/consumption, and the purchase's resulting status all commit
    // or roll back together.
    await req.db.transaction(async (trx) => {
      for (const update of lines) {
        const line = existingLines.find(l => l.id === update.purchaseItemId);
        if (!line) continue;
        const newReceived = Math.max(0, Math.min(Number(line.quantity_ordered), Number(update.quantityReceived || 0)));
        const delta = newReceived - Number(line.quantity_received || 0);
        if (delta === 0) continue;

        if (delta > 0) {
          const landedUnitCost = (Number(line.unit_cost || 0) * Number(line.quantity_ordered)
            + Number(line.freight_cost || 0) + Number(line.import_charges || 0))
            / Number(line.quantity_ordered);
          await createLot(trx, {
            itemId: line.item_id,
            lotRef: `${purchase.po_number || purchase.id}-${line.id.slice(-6)}`,
            vendorId: purchase.vendor_id, purchaseItemId: line.id,
            quantity: delta, unitCost: landedUnitCost,
            receivedDate: new Date(), source: 'purchase',
          });
        } else {
          // Receiving was reduced (e.g. correcting an over-receipt) — consume
          // back out of that item's stock. This is a rare correction path, so
          // we accept it may touch a different (newer) lot than the one this
          // receipt originally created; recomputeItemStock keeps totals correct.
          await consumeStockFIFO(trx, line.item_id, Math.abs(delta));
        }
        await trx('inv_purchase_items').where({ id: line.id }).update({ quantity_received: newReceived });
        touchedItemIds.add(line.item_id);
      }

      for (const itemId of touchedItemIds) {
        await recomputeItemStock(trx, itemId);
      }

      const refreshedLines = await trx('inv_purchase_items').where({ purchase_id: req.params.id });
      const totalOrdered = refreshedLines.reduce((s, l) => s + Number(l.quantity_ordered), 0);
      const totalReceived = refreshedLines.reduce((s, l) => s + Number(l.quantity_received || 0), 0);
      const newStatus = totalReceived <= 0 ? 'pending' : (totalReceived >= totalOrdered ? 'received' : 'partial');
      await trx('inv_purchases').where({ id: req.params.id }).update({
        status: newStatus, updated_at: new Date(),
        ...(newStatus === 'received' ? { received_date: new Date() } : {}),
      });
    });

    const refreshedLines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    for (const itemId of touchedItemIds) {
      const savedItem = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(savedItem));
    }

    const saved = await req.db('inv_purchases').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(saved));
    res.json({ ...mapPurchase(saved), items: refreshedLines.map(mapPurchaseItem) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /purchases/:purchaseId/items/:itemId — edit a single purchase line's
// ordered quantity / unit cost / vendor code / lead time (not its received
// quantity — that's handled by /receive-lines to keep stock lot logic in
// one place). Blocks shrinking quantityOrdered below what's already received.
router.patch('/purchases/:purchaseId/items/:lineId', async (req, res) => {
  try {
    const line = await req.db('inv_purchase_items').where({ id: req.params.lineId, purchase_id: req.params.purchaseId }).first();
    if (!line) return res.status(404).json({ error: 'Purchase line not found' });
    const b = req.body;
    const updates = {};
    if (b.quantityOrdered !== undefined) {
      if (Number(b.quantityOrdered) < Number(line.quantity_received || 0)) {
        return res.status(400).json({ error: 'Cannot reduce ordered quantity below what has already been received' });
      }
      updates.quantity_ordered = b.quantityOrdered;
    }
    if (b.vendorItemCode !== undefined) updates.vendor_item_code = b.vendorItemCode;
    if (b.unitCost !== undefined) updates.unit_cost = b.unitCost;
    if (b.freightCost !== undefined) updates.freight_cost = b.freightCost;
    if (b.importCharges !== undefined) updates.import_charges = b.importCharges;
    if (b.leadTimeDays !== undefined) updates.lead_time_days = b.leadTimeDays;
    if (Object.keys(updates).length) await req.db('inv_purchase_items').where({ id: req.params.lineId }).update(updates);
    const saved = await req.db('inv_purchase_items').where({ id: req.params.lineId }).first();
    const savedPurchase = await req.db('inv_purchases').where({ id: req.params.purchaseId }).first();
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(savedPurchase));
    res.json(mapPurchaseItem(saved));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/purchases/:id', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const lines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const lineIds = lines.map(l => l.id);
    const lots = lineIds.length ? await req.db('inv_stock_lots').whereIn('purchase_item_id', lineIds) : [];

    // If any of this purchase's stock has already been consumed downstream
    // (built into an assembly), we can't cleanly reverse it — the
    // consumption record (mfg_assembly_items.consumed_lot_id) would be left
    // pointing at a lot whose remaining quantity no longer reflects reality,
    // and reducing quantity_remaining below zero would misrepresent stock.
    // This is a real safety boundary, not an arbitrary block: it protects
    // downstream records that legitimately depend on this stock having
    // existed, same as the sold-unit check on assembly reversal.
    const lotIds = lots.map(l => l.id);
    if (lotIds.length) {
      const consumed = await req.db('mfg_assembly_items')
        .whereIn('consumed_lot_id', lotIds)
        .whereExists(function () {
          this.select('*').from('mfg_assemblies')
            .whereRaw('mfg_assemblies.id = mfg_assembly_items.assembly_id')
            .whereNot({ status: 'reversed' });
        })
        .first();
      if (consumed) {
        return res.status(400).json({ error: 'Stock from this purchase has already been used in an active manufacturing assembly and cannot be safely removed. Reverse the assembly first if you need to undo this.' });
      }
    }

    await req.db.transaction(async (trx) => {
      // Reverse each line's received quantity from the item's stock, then
      // remove the lots and lines, then the purchase itself. This lets a
      // received (or partially-received) purchase actually be deleted,
      // rather than permanently blocking it — matching how assembly
      // reversal works elsewhere in the app.
      const itemIds = [...new Set(lines.map(l => l.item_id))];
      if (lotIds.length) await trx('inv_stock_lots').whereIn('id', lotIds).delete();
      if (lineIds.length) await trx('inv_purchase_items').whereIn('id', lineIds).delete();
      await trx('inv_purchases').where({ id: req.params.id }).delete();
      for (const itemId of itemIds) await recomputeItemStock(trx, itemId);
    });

    req.io.to(req.company.slug).emit('inv:purchase_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── One-time backfill ────────────────────────────────────────────────────────
// POST /api/:slug/inventory/backfill-lot-vendors
// Historical stock lots created before vendor tracking was wired through
// end-to-end may have vendor_id = NULL even though they came from a purchase
// with a known vendor (traceable via purchase_item_id -> inv_purchases).
// This fixes those in place. Safe to re-run — only touches lots that are
// currently NULL and have a resolvable vendor.
router.post('/backfill-lot-vendors', async (req, res) => {
  try {
    const orphanLots = await req.db('inv_stock_lots')
      .whereNull('vendor_id')
      .whereNotNull('purchase_item_id');
    let fixed = 0;
    for (const lot of orphanLots) {
      const purchaseItem = await req.db('inv_purchase_items').where({ id: lot.purchase_item_id }).first();
      if (!purchaseItem) continue;
      const purchase = await req.db('inv_purchases').where({ id: purchaseItem.purchase_id }).first();
      if (!purchase || !purchase.vendor_id) continue;
      await req.db('inv_stock_lots').where({ id: lot.id }).update({ vendor_id: purchase.vendor_id });
      fixed++;
    }
    res.json({ checked: orphanLots.length, fixed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;