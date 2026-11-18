const express = require('express');
const router = express.Router();
const { recomputeItemStock, consumeStockFIFO, createLot } = require('../utils/stockLots');
const { getHistoricalRate, getLatestRate, BASE_CURRENCY } = require('../utils/currencyConvert');

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
  currency: r.currency,
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
  // Line total (unitCost*qty + freight + import), in the purchase's own
  // currency — this is the real figure the "Total Lead Time" column was
  // actually showing (a naming bug, nothing to do with lead_time_days);
  // exposed explicitly so the frontend doesn't have to re-derive it.
  totalValue: Math.round((Number(r.unit_cost || 0) * Number(r.quantity_ordered || 0)
    + Number(r.freight_cost || 0) + Number(r.import_charges || 0)) * 100) / 100,
});

const mapSerialUnit = (r) => r && ({
  id: r.id, itemId: r.item_id, lotId: r.lot_id, purchaseItemId: r.purchase_item_id,
  unitNumber: r.unit_number, serialNumber: r.serial_number, createdAt: r.created_at,
});

// Creates one inv_purchase_serial_units row per unit just received, only when
// the item is serial_tracked — mirrors mfg_assembly_units' pattern (created
// with serial_number NULL, assigned later via the Traceability page).
// unit_number continues from whatever's already on file for this item, so
// numbering stays unique per item across every lot it was ever received in,
// not just within this one lot.
async function createSerialUnitsForLot(db, { itemId, lotId, purchaseItemId, quantity }) {
  const item = await db('inv_items').where({ id: itemId }).first();
  if (!item || !item.serial_tracked) return;
  const count = Math.round(Number(quantity));
  if (count <= 0) return;
  const last = await db('inv_purchase_serial_units').where({ item_id: itemId }).orderBy('unit_number', 'desc').first();
  let nextNum = last ? last.unit_number + 1 : 1;
  for (let i = 0; i < count; i++) {
    await db('inv_purchase_serial_units').insert({
      id: 'psu_' + Date.now() + Math.random().toString(36).slice(2, 6),
      item_id: itemId, lot_id: lotId, purchase_item_id: purchaseItemId || null,
      unit_number: nextNum++,
    });
  }
}

// Below this tolerance a remaining quantity is treated as zero — same
// rationale/value as stockLots.js's own QTY_EPSILON (DECIMAL(14,2) columns
// can carry fractional units, so an exact-equality check would misfire on
// floating-point noise).
const QTY_EPSILON = 1e-6;

// Reverses one or more Outward issues (inv_stock_issues) together in a
// single DB transaction — adds each issue's consumed quantity back onto the
// EXACT lot(s) it was drawn from (recorded in inv_stock_issue_lots at the
// time of consumption), then removes the issue and its lot rows. This is
// always safe to just add back, regardless of what else has happened to
// that lot since (another, later issue drawing further from it doesn't
// change the math — it's pure additive bookkeeping) — unlike reversing an
// Inward return below, which can't safely subtract if the lot was already
// drawn down by a later issue. Refuses the WHOLE operation (nothing
// partially reversed) if any referenced lot no longer exists at all (e.g.
// the purchase that created it was since deleted) rather than silently
// under-restoring stock — mirrors the safety check DELETE /purchases/:id
// already uses for exactly this kind of "can we cleanly undo this" question.
async function reverseIssues(db, issues) {
  const touchedItemIds = new Set();
  await db.transaction(async (trx) => {
    for (const issue of issues) {
      const issueLots = await trx('inv_stock_issue_lots').where({ issue_id: issue.id });
      for (const il of issueLots) {
        const lot = await trx('inv_stock_lots').where({ id: il.lot_id }).first();
        if (!lot) {
          throw new Error('Cannot delete this transaction — one of the stock lots it drew from no longer exists.');
        }
        await trx('inv_stock_lots').where({ id: il.lot_id }).update({
          quantity_remaining: Number(lot.quantity_remaining) + Number(il.quantity),
        });
      }
      await trx('inv_stock_issue_lots').where({ issue_id: issue.id }).delete();
      await trx('inv_stock_issues').where({ id: issue.id }).delete();
      touchedItemIds.add(issue.item_id);
    }
    for (const itemId of touchedItemIds) await recomputeItemStock(trx, itemId);
  });
  return [...touchedItemIds];
}

// Reverses one or more Inward (customer-return) transactions
// (inv_stock_returns) together in a single DB transaction — each return
// created exactly one new stock lot (lot_id, stored directly on the return
// row), so reversing means deducting that same quantity back out of that
// lot. Unlike reverseIssues above, this direction genuinely CAN be unsafe:
// if a later Outward issue already drew some of this returned stock back
// out via FIFO, quantity_remaining may now be less than what we'd need to
// remove — refuse the whole operation rather than driving it negative or
// silently under-reversing.
async function reverseReturns(db, returns) {
  const touchedItemIds = new Set();
  await db.transaction(async (trx) => {
    for (const ret of returns) {
      const lot = await trx('inv_stock_lots').where({ id: ret.lot_id }).first();
      if (!lot) {
        throw new Error('Cannot delete this transaction — its stock lot no longer exists.');
      }
      const remaining = Number(lot.quantity_remaining);
      const originalQty = Number(ret.quantity);
      if (remaining < originalQty - QTY_EPSILON) {
        throw new Error('Some of this returned stock has already been issued back out and cannot be safely reversed. Reverse or edit the later Outward transaction(s) first.');
      }
      await trx('inv_stock_lots').where({ id: ret.lot_id }).update({
        quantity_remaining: remaining - originalQty,
      });
      await trx('inv_stock_returns').where({ id: ret.id }).delete();
      touchedItemIds.add(ret.item_id);
    }
    for (const itemId of touchedItemIds) await recomputeItemStock(trx, itemId);
  });
  return [...touchedItemIds];
}

// ── Vendors ───────────────────────────────────────────────────────────────────

// Vendor list, each gaining a real `totalValue` — the sum, across every PO
// line ever placed with that vendor, of (unitCost*qty + freight + import),
// converted to BASE_CURRENCY (INR) using that PO's own historical order-date
// rate (same real-conversion approach already used when stock is actually
// received — see utils/currencyConvert.js's own incident writeup). Vendors
// are genuinely billed in a mix of currencies here, so summing raw numbers
// across POs without converting first would silently add USD to EUR to INR.
// A PO whose historical rate can't be fetched is skipped from the sum
// (rather than guessed) and doesn't block the rest of the list from loading.
router.get('/vendors', async (req, res) => {
  try {
    const rows = await req.db('inv_vendors').orderBy('name', 'asc');
    const vendors = rows.map(mapVendor);

    const purchases = await req.db('inv_purchases');
    const purchaseIds = purchases.map(p => p.id);
    const lines = purchaseIds.length
      ? await req.db('inv_purchase_items').whereIn('purchase_id', purchaseIds)
      : [];
    const linesByPurchase = new Map();
    for (const line of lines) {
      if (!linesByPurchase.has(line.purchase_id)) linesByPurchase.set(line.purchase_id, []);
      linesByPurchase.get(line.purchase_id).push(line);
    }

    const totalsByVendor = new Map();
    for (const purchase of purchases) {
      const poLines = linesByPurchase.get(purchase.id) || [];
      if (!poLines.length) continue;
      let rate;
      try { rate = await getHistoricalRate(purchase.currency, new Date(purchase.order_date)); }
      catch { continue; } // couldn't price this PO — skip it rather than guess, don't fail the whole list
      let subtotal = 0;
      for (const line of poLines) {
        subtotal += (Number(line.unit_cost || 0) * Number(line.quantity_ordered || 0)
          + Number(line.freight_cost || 0) + Number(line.import_charges || 0)) * rate;
      }
      totalsByVendor.set(purchase.vendor_id, (totalsByVendor.get(purchase.vendor_id) || 0) + subtotal);
    }
    for (const v of vendors) {
      const total = totalsByVendor.get(v.id) || 0;
      v.totalValue = Math.round(total * 100) / 100;
      v.totalValueCurrency = BASE_CURRENCY;
    }
    res.json(vendors);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live display-only currency conversion — does NOT touch any stored amount.
// Returns a "multiply by this" rate, into `to`, for every currency actually
// in use on this tenant's vendors/purchases (plus INR and `to` itself), so
// the frontend's currency-toggle button can convert whatever's on screen
// (already in each row's own real currency) without the user juggling rates
// by hand. Vendors' totalValue (above) is always already in INR — convert
// it with rates[BASE_CURRENCY] same as any other INR amount.
router.get('/fx-rates', async (req, res) => {
  try {
    const to = (req.query.to || BASE_CURRENCY).toUpperCase();
    const vendorCurrencies = await req.db('inv_vendors').distinct('currency');
    const purchaseCurrencies = await req.db('inv_purchases').distinct('currency');
    const currencies = new Set([BASE_CURRENCY, to]);
    for (const r of vendorCurrencies) if (r.currency) currencies.add(String(r.currency).toUpperCase());
    for (const r of purchaseCurrencies) if (r.currency) currencies.add(String(r.currency).toUpperCase());

    const rates = {};
    for (const cur of currencies) {
      try { rates[cur] = await getLatestRate(cur, to); }
      catch { rates[cur] = null; } // couldn't price this currency right now — frontend should leave those amounts in their original currency, not guess
    }
    res.json({ to, rates, asOf: new Date() });
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
    if (req.query.serialTracked === 'true') q = q.where({ serial_tracked: true });
    if (req.query.alerts === 'true') {
      // Only return items that are below min or at reorder level
      q = q.whereRaw('(stock_min > 0 AND stock < stock_min) OR (stock_reorder > 0 AND stock <= stock_reorder)');
    }
    const rows = await q.orderBy('name', 'asc');
    res.json(rows.map(mapItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Total value of everything on hand — sum of (stock × avgCost) across every
// item, for the summary tile at the top of the Inventory page. avgCost is
// the weighted-average cost already maintained on each item (see
// recomputeItemStock in utils/stockLots.js) rather than sale price, since
// this module has no per-item sale price — that only exists per-sale-line.
router.get('/items/summary', async (req, res) => {
  try {
    const rows = await req.db('inv_items').select('stock', 'avg_cost');
    let totalStockValue = 0;
    for (const r of rows) totalStockValue += Number(r.stock || 0) * Number(r.avg_cost || 0);
    res.json({ totalItems: rows.length, totalStockValue, asOf: new Date() });
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
      const sourceLabel = { purchase: 'a purchase order', assembly: 'a manufacturing assembly', manual: 'a manual stock adjustment', customer_return: 'a customer return (Inward)' }[receivedLots.source] || 'stock history';
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
    await req.db('inv_stock_returns').where({ item_id: req.params.id }).delete();
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
      invoiceNumber: l.invoice_number || null,
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

// "Inward Outward" — OUTWARD side: stock LEAVING for a customer (e.g. a
// manual replacement part sent out), deducted immediately. customerId is
// optional so this endpoint still covers the older plain internal-
// consumption issue case unchanged. See /items/:id/receive-from-customer
// just below for the separate INWARD (stock coming back) side.
router.post('/items/:id/issue', async (req, res) => {
  try {
    const { quantity, details, issueDate, customerId } = req.body;
    if (quantity == null || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity is required and must be positive' });
    }
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // customerId is optional — this same endpoint covers both a plain
    // internal-consumption issue and the "Inward Outward" manual
    // replacement-part-to-customer case. Snapshotting the name (not just the
    // id) keeps the issue history readable even if the customer is later
    // renamed/deleted.
    let customerName = null;
    if (customerId) {
      const customer = await req.db('customers').where({ id: customerId }).first();
      if (!customer) return res.status(400).json({ error: 'Customer not found' });
      customerName = customer.name;
    }

    const consumed = await consumeStockFIFO(req.db, req.params.id, Number(quantity));
    const issueId = 'iss_' + Date.now();
    await req.db('inv_stock_issues').insert({
      id: issueId, item_id: req.params.id, quantity,
      issue_date: issueDate || new Date(), details: details || null,
      customer_id: customerId || null, customer_name: customerName,
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

// Issue history — covers both plain internal-consumption issues and
// customer-attributed "Inward Outward" issues (customerId present). No
// GET existed on this table before; filters mirror the common history-view
// needs (by item, by customer, by date range).
router.get('/issues', async (req, res) => {
  try {
    let q = req.db('inv_stock_issues');
    if (req.query.itemId) q = q.where({ item_id: req.query.itemId });
    if (req.query.customerId) q = q.where({ customer_id: req.query.customerId });
    if (req.query.dateFrom) q = q.where('issue_date', '>=', req.query.dateFrom);
    if (req.query.dateTo) q = q.where('issue_date', '<=', req.query.dateTo);
    const rows = await q.orderBy('issue_date', 'desc').orderBy('created_at', 'desc');
    const itemIds = [...new Set(rows.map(r => r.item_id))];
    const items = itemIds.length ? await req.db('inv_items').whereIn('id', itemIds) : [];
    const itemById = new Map(items.map(i => [i.id, i]));
    res.json(rows.map(r => ({
      id: r.id, batchId: r.batch_id, itemId: r.item_id, itemName: itemById.get(r.item_id)?.name || null,
      itemCode: itemById.get(r.item_id)?.item_code || null,
      quantity: Number(r.quantity), issueDate: r.issue_date, details: r.details,
      customerId: r.customer_id, customerName: r.customer_name,
      createdBy: r.created_by, createdAt: r.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Outward, multi-item: one customer, one submission, several items in one
// go — each line still consumes stock independently (FIFO against that
// item's own lots) and gets its own inv_stock_issues row, but all the rows
// from one submission share a batch_id so the history view can group them
// as a single transaction. Fails the WHOLE batch before touching any stock
// if any line is invalid (bad item/qty) or the customer id doesn't exist —
// never partially issues some lines and not others.
router.post('/items/issue-batch', async (req, res) => {
  try {
    const { customerId, issueDate, details, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'At least one line item is required' });
    }
    for (const line of lines) {
      if (!line.itemId || line.quantity == null || Number(line.quantity) <= 0) {
        return res.status(400).json({ error: 'Each line needs a valid itemId and a positive quantity' });
      }
    }
    let customerName = null;
    if (customerId) {
      const customer = await req.db('customers').where({ id: customerId }).first();
      if (!customer) return res.status(400).json({ error: 'Customer not found' });
      customerName = customer.name;
    }
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.itemId }).first();
      if (!item) return res.status(400).json({ error: `Item not found: ${line.itemId}` });
    }

    const batchId = 'issb_' + Date.now();
    const results = [];
    for (const line of lines) {
      const consumed = await consumeStockFIFO(req.db, line.itemId, Number(line.quantity));
      const issueId = 'iss_' + Date.now() + Math.random().toString(36).slice(2, 6);
      await req.db('inv_stock_issues').insert({
        id: issueId, batch_id: batchId, item_id: line.itemId, quantity: line.quantity,
        issue_date: issueDate || new Date(), details: details || null,
        customer_id: customerId || null, customer_name: customerName,
        created_by: req.user?.userId || null,
      });
      for (const c of consumed) {
        await req.db('inv_stock_issue_lots').insert({
          id: 'isl_' + Date.now() + Math.random().toString(36).slice(2, 6),
          issue_id: issueId, lot_id: c.lotId, quantity: c.quantityConsumed,
        });
      }
      await recomputeItemStock(req.db, line.itemId);
      const saved = await req.db('inv_items').where({ id: line.itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
      results.push({ issueId, itemId: line.itemId, consumed, item: mapItem(saved) });
    }
    res.json({ batchId, results });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// "Inward Outward" — INWARD side: stock coming BACK from a customer (e.g. a
// returned/replaced part), added back to real stock immediately. A separate
// endpoint/table from Outward's /issue+inv_stock_issues on purpose — these
// are two distinct forms in the UI, not one form with a signed quantity.
// Creates a real new stock lot (source: 'customer_return') so the returned
// quantity becomes normal, FIFO-consumable stock again, not a separate pool.
router.post('/items/:id/receive-from-customer', async (req, res) => {
  try {
    const { quantity, details, returnDate, customerId, unitCost } = req.body;
    if (quantity == null || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity is required and must be positive' });
    }
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let customerName = null;
    if (customerId) {
      const customer = await req.db('customers').where({ id: customerId }).first();
      if (!customer) return res.status(400).json({ error: 'Customer not found' });
      customerName = customer.name;
    }

    const lotId = await createLot(req.db, {
      itemId: req.params.id, quantity: Number(quantity),
      unitCost: unitCost != null ? Number(unitCost) : (item.avg_cost || 0),
      receivedDate: returnDate || new Date(), source: 'customer_return',
      notes: details || null,
    });
    const returnId = 'ret_' + Date.now();
    await req.db('inv_stock_returns').insert({
      id: returnId, item_id: req.params.id, lot_id: lotId, quantity,
      return_date: returnDate || new Date(), details: details || null,
      customer_id: customerId || null, customer_name: customerName,
      created_by: req.user?.userId || null,
    });
    await recomputeItemStock(req.db, req.params.id);
    const saved = await req.db('inv_items').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    res.json({ returnId, lotId, item: mapItem(saved) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Inward, multi-item: same shape as Outward's /items/issue-batch above — one
// customer, one submission, several items, each getting its own real stock
// lot + inv_stock_returns row, all sharing one batch_id. No unitCost field
// here either (same as the single-item endpoint above) — every line is
// valued at that item's own current average cost automatically.
router.post('/items/receive-from-customer-batch', async (req, res) => {
  try {
    const { customerId, returnDate, details, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'At least one line item is required' });
    }
    for (const line of lines) {
      if (!line.itemId || line.quantity == null || Number(line.quantity) <= 0) {
        return res.status(400).json({ error: 'Each line needs a valid itemId and a positive quantity' });
      }
    }
    let customerName = null;
    if (customerId) {
      const customer = await req.db('customers').where({ id: customerId }).first();
      if (!customer) return res.status(400).json({ error: 'Customer not found' });
      customerName = customer.name;
    }
    const itemsById = new Map();
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.itemId }).first();
      if (!item) return res.status(400).json({ error: `Item not found: ${line.itemId}` });
      itemsById.set(line.itemId, item);
    }

    const batchId = 'retb_' + Date.now();
    const results = [];
    for (const line of lines) {
      const item = itemsById.get(line.itemId);
      const lotId = await createLot(req.db, {
        itemId: line.itemId, quantity: Number(line.quantity),
        unitCost: item.avg_cost || 0,
        receivedDate: returnDate || new Date(), source: 'customer_return',
        notes: details || null,
      });
      const returnId = 'ret_' + Date.now() + Math.random().toString(36).slice(2, 6);
      await req.db('inv_stock_returns').insert({
        id: returnId, batch_id: batchId, item_id: line.itemId, lot_id: lotId, quantity: line.quantity,
        return_date: returnDate || new Date(), details: details || null,
        customer_id: customerId || null, customer_name: customerName,
        created_by: req.user?.userId || null,
      });
      await recomputeItemStock(req.db, line.itemId);
      const saved = await req.db('inv_items').where({ id: line.itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
      results.push({ returnId, lotId, itemId: line.itemId, item: mapItem(saved) });
    }
    res.json({ batchId, results });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Inward (customer-return) history — same filter shape as /issues (Outward).
router.get('/returns', async (req, res) => {
  try {
    let q = req.db('inv_stock_returns');
    if (req.query.itemId) q = q.where({ item_id: req.query.itemId });
    if (req.query.customerId) q = q.where({ customer_id: req.query.customerId });
    if (req.query.dateFrom) q = q.where('return_date', '>=', req.query.dateFrom);
    if (req.query.dateTo) q = q.where('return_date', '<=', req.query.dateTo);
    const rows = await q.orderBy('return_date', 'desc').orderBy('created_at', 'desc');
    const itemIds = [...new Set(rows.map(r => r.item_id))];
    const items = itemIds.length ? await req.db('inv_items').whereIn('id', itemIds) : [];
    const itemById = new Map(items.map(i => [i.id, i]));
    res.json(rows.map(r => ({
      id: r.id, batchId: r.batch_id, itemId: r.item_id, itemName: itemById.get(r.item_id)?.name || null,
      itemCode: itemById.get(r.item_id)?.item_code || null,
      quantity: Number(r.quantity), returnDate: r.return_date, details: r.details,
      customerId: r.customer_id, customerName: r.customer_name,
      createdBy: r.created_by, createdAt: r.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE a single Outward transaction line (one inv_stock_issues row — a
// standalone single-item issue, or one line within a multi-item batch).
// For deleting a WHOLE multi-item batch together, use the /issues/batch/:id
// route below instead — this one only ever touches the one row named.
router.delete('/issues/:id', async (req, res) => {
  try {
    const issue = await req.db('inv_stock_issues').where({ id: req.params.id }).first();
    if (!issue) return res.status(404).json({ error: 'Transaction not found' });
    await reverseIssues(req.db, [issue]);
    const saved = await req.db('inv_items').where({ id: issue.item_id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    req.io.to(req.company.slug).emit('inv:issue_deleted', { id: issue.id, batchId: issue.batch_id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE a whole multi-item Outward transaction (every inv_stock_issues row
// sharing one batch_id from a single issue-batch submission) — all lines
// reversed together in one DB transaction, per requirement 6 (no partial
// updates): either every line's stock is restored and every row removed,
// or (on any single line failing its safety check) nothing is.
router.delete('/issues/batch/:batchId', async (req, res) => {
  try {
    const issues = await req.db('inv_stock_issues').where({ batch_id: req.params.batchId });
    if (!issues.length) return res.status(404).json({ error: 'Transaction not found' });
    const touchedItemIds = await reverseIssues(req.db, issues);
    for (const itemId of touchedItemIds) {
      const saved = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    }
    req.io.to(req.company.slug).emit('inv:issue_deleted', { batchId: req.params.batchId });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE a single Inward transaction line (one inv_stock_returns row).
// See /returns/batch/:id below for deleting a whole multi-item batch.
router.delete('/returns/:id', async (req, res) => {
  try {
    const ret = await req.db('inv_stock_returns').where({ id: req.params.id }).first();
    if (!ret) return res.status(404).json({ error: 'Transaction not found' });
    await reverseReturns(req.db, [ret]);
    const saved = await req.db('inv_items').where({ id: ret.item_id }).first();
    req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    req.io.to(req.company.slug).emit('inv:return_deleted', { id: ret.id, batchId: ret.batch_id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE a whole multi-item Inward transaction (every inv_stock_returns row
// sharing one batch_id) — same all-or-nothing guarantee as the Outward
// batch delete above.
router.delete('/returns/batch/:batchId', async (req, res) => {
  try {
    const returns = await req.db('inv_stock_returns').where({ batch_id: req.params.batchId });
    if (!returns.length) return res.status(404).json({ error: 'Transaction not found' });
    const touchedItemIds = await reverseReturns(req.db, returns);
    for (const itemId of touchedItemIds) {
      const saved = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', mapItem(saved));
    }
    req.io.to(req.company.slug).emit('inv:return_deleted', { batchId: req.params.batchId });
    res.json({ success: true });
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

// GET /purchases/:id/receipts — receipt history for a purchase: one row per
// stock lot created by /receive or /receive-lines (i.e. per line per
// delivery), each with the invoice number captured for that delivery.
router.get('/purchases/:id/receipts', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const lines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const lineIds = lines.map(l => l.id);
    const lots = lineIds.length
      ? await req.db('inv_stock_lots').whereIn('purchase_item_id', lineIds)
          .orderBy('received_date', 'asc').orderBy('created_at', 'asc')
      : [];
    res.json(lots.map(l => ({
      lotId: l.id, lotRef: l.lot_ref, purchaseItemId: l.purchase_item_id, itemId: l.item_id,
      quantityReceived: Number(l.quantity_received),
      invoiceNumber: l.invoice_number || null,
      receivedDate: l.received_date, createdAt: l.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/purchases', async (req, res) => {
  try {
    const { poNumber, vendorId, orderDate, expectedDate, invoiceNumber, currency, notes, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one line item is required' });
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
    const vendor = await req.db('inv_vendors').where({ id: vendorId }).first();
    if (!vendor) return res.status(400).json({ error: 'Vendor not found' });

    const id = 'po_' + Date.now();
    await req.db('inv_purchases').insert({
      id, po_number: poNumber || null, vendor_id: vendorId, status: 'pending',
      order_date: orderDate || new Date(), expected_date: expectedDate || null,
      invoice_number: invoiceNumber || null,
      // Defaults to the vendor's own currency, but selectable/overridable per
      // PO — the same vendor can still be paid in a different currency on a
      // given order.
      currency: currency || vendor.currency || 'INR',
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

// ── Excel import for Purchases ──────────────────────────────────────────────
// The frontend reads the spreadsheet itself and sends plain JSON rows here —
// one row = one item line. Rows sharing the same (trimmed, case-insensitive)
// PO number are grouped into one purchase, same shape POST /purchases above
// already creates (status 'pending', no stock/lots/serial units touched —
// receiving still happens afterward through the normal /receive or
// /receive-lines flow, completely unchanged by this).
const IMPORT_MAX_ROWS = 2000;
const IMPORT_CONSISTENCY_FIELDS = ['vendorCode', 'purchaseDate', 'currency', 'invoiceNumber'];

function normalizePoNumber(v) {
  return String(v || '').trim().toLowerCase();
}

function parseImportDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Loose comparison key for item matching. Lookup/comparison only — never
// written back to the DB. In order:
//  1. Unicode NFC (so "Ö" typed as O + combining umlaut equals the single "Ö")
//  2. strip accents: decompose (NFD) and drop combining marks ("Ö" -> "O"),
//     plus a small map for letters that don't decompose (Ø, Ł, ß, Æ, Œ, ...)
//  3. drop the ®, ™ and © symbols
//  4. drop ALL whitespace, incl. non-breaking, narrow and zero-width spaces
//  5. lowercase
// e.g. "ÖLFLEX® UNIPLUS 1X1.5 BK" -> "olflexuniplus1x1.5bk"
const MATCH_CHAR_MAP = {
  'Ø': 'O', 'ø': 'o', 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ð': 'D', 'ð': 'd',
  'Þ': 'Th', 'þ': 'th', 'ß': 'ss', 'ẞ': 'SS', 'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'ı': 'i',
};
function normalizeForMatch(v) {
  return String(v ?? '')
    .normalize('NFC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ØøŁłĐđÐðÞþßẞÆæŒœı]/g, (ch) => MATCH_CHAR_MAP[ch])
    .replace(/[®™©]/g, '')
    .replace(/[\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g, '')
    .toLowerCase();
}

// Levenshtein distance that gives up early (returns max + 1) once a whole
// row exceeds `max` — only used to rank "Did you mean" suggestions, so far-off
// items are skipped cheaply.
function boundedLevenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Up to `limit` existing items closest to `raw` (comparing normalized item
// code, name and display name), one entry per item, formatted for an error
// message: the item code, plus the name in brackets when the name was closer.
function closestItemLabels(raw, allItems, limit = 3) {
  const key = normalizeForMatch(raw);
  const best = []; // { dist, label }, sorted ascending, length <= limit
  for (const it of allItems) {
    let itemBest = null;
    for (const value of [it.item_code, it.name, it.display_name]) {
      if (!value) continue;
      const norm = normalizeForMatch(value);
      let cap = best.length < limit ? Math.max(key.length, norm.length) : best[best.length - 1].dist - 1;
      if (itemBest) cap = Math.min(cap, itemBest.dist - 1);
      if (cap < 0) continue;
      const d = boundedLevenshtein(key, norm, cap);
      if (d <= cap) itemBest = { dist: d, value };
    }
    if (!itemBest) continue;
    const label = it.item_code && itemBest.value !== it.item_code
      ? `${it.item_code} (${itemBest.value})`
      : itemBest.value;
    best.push({ dist: itemBest.dist, label });
    best.sort((x, y) => x.dist - y.dist);
    if (best.length > limit) best.pop();
  }
  return best.map((b) => b.label);
}

// Same SQL Server unique-constraint/unique-index violation signal already
// used in sitara.js's isUniqueViolation — duplicated locally (a one-line,
// driver-shape check, not worth cross-file coupling for) rather than
// imported from there. inv_purchases has no unique index on po_number YET
// (a separate, still-pending change) — this exists so the code is already
// correct the day that index does land, at zero cost today; until then the
// real (narrow) duplicate-race guard is the fresh SELECT re-check done
// inside the transaction below, immediately before each insert.
function isImportUniqueViolation(e) {
  const num = e?.number ?? e?.originalError?.info?.number ?? e?.code;
  return num === 2601 || num === 2627;
}

router.post('/purchases/import', async (req, res) => {
  try {
    const dryRun = !!req.body.dryRun;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'rows is required and must be a non-empty array' });
    if (rows.length > IMPORT_MAX_ROWS) {
      return res.status(400).json({ error: `Cannot import more than ${IMPORT_MAX_ROWS} rows in one file.` });
    }

    const errors = [];
    const addError = (rowNumber, column, message) => errors.push({ rowNumber, column, message });
    const warnings = [];
    const addWarning = (rowNumber, column, message) => warnings.push({ rowNumber, column, message });

    // ── Per-row field validation (collects every error, never stops early) ──
    for (const row of rows) {
      const rn = row.rowNumber;
      if (!row.poNumber || !String(row.poNumber).trim()) addError(rn, 'poNumber', 'PO number is required');
      if (!row.vendorCode || !String(row.vendorCode).trim()) addError(rn, 'vendorCode', 'Vendor code is required');
      if (!parseImportDate(row.purchaseDate)) addError(rn, 'purchaseDate', 'A valid purchase date is required');
      if (row.currency !== undefined && row.currency !== null && String(row.currency).trim() !== ''
        && !/^[A-Za-z]{3}$/.test(String(row.currency).trim())) {
        addError(rn, 'currency', 'Currency must be a 3-letter code');
      }
      if (!row.itemCode || !String(row.itemCode).trim()) addError(rn, 'itemCode', 'Item code is required');
      if (row.quantity == null || isNaN(Number(row.quantity)) || Number(row.quantity) <= 0) {
        addError(rn, 'quantity', 'Quantity is required and must be greater than 0');
      }
      if (row.unitCost == null || isNaN(Number(row.unitCost)) || Number(row.unitCost) < 0) {
        addError(rn, 'unitCost', 'Unit cost is required and must be 0 or more');
      }
      if (row.leadTimeDays !== undefined && row.leadTimeDays !== null && row.leadTimeDays !== '') {
        const lt = Number(row.leadTimeDays);
        if (isNaN(lt) || lt < 0 || !Number.isInteger(lt)) addError(rn, 'leadTimeDays', 'Lead time days must be a whole number 0 or more');
      }
      if (row.freightCharges !== undefined && row.freightCharges !== null && row.freightCharges !== ''
        && (isNaN(Number(row.freightCharges)) || Number(row.freightCharges) < 0)) {
        addError(rn, 'freightCharges', 'Freight charges must be 0 or more');
      }
      if (row.importCharges !== undefined && row.importCharges !== null && row.importCharges !== ''
        && (isNaN(Number(row.importCharges)) || Number(row.importCharges) < 0)) {
        addError(rn, 'importCharges', 'Import charges must be 0 or more');
      }
    }

    // ── Group rows sharing the same normalized PO number ─────────────────
    const groups = new Map(); // normalizedPo -> { poNumber (first raw value), rows: [...] }
    for (const row of rows) {
      if (!row.poNumber || !String(row.poNumber).trim()) continue; // already flagged above
      const key = normalizePoNumber(row.poNumber);
      if (!groups.has(key)) groups.set(key, { poNumber: String(row.poNumber).trim(), rows: [] });
      groups.get(key).rows.push(row);
    }

    // ── Within one PO, vendorCode/purchaseDate/currency/invoiceNumber must
    // all match across every row ──
    for (const group of groups.values()) {
      const [first, ...rest] = group.rows;
      for (const field of IMPORT_CONSISTENCY_FIELDS) {
        const baseline = String(first[field] ?? '').trim();
        for (const row of rest) {
          if (String(row[field] ?? '').trim() !== baseline) {
            addError(row.rowNumber, field, `All rows for PO "${group.poNumber}" must have the same ${field}`);
          }
        }
      }
    }

    // ── Vendor / item lookups — exact code match (case-insensitive), else
    // a unique case-insensitive name match ──
    const vendorCache = new Map();
    async function resolveVendor(code) {
      const key = String(code).trim().toLowerCase();
      if (vendorCache.has(key)) return vendorCache.get(key);
      let vendor = await req.db('inv_vendors').whereRaw('LOWER(vendor_code) = ?', [key]).first();
      if (!vendor) {
        const byName = await req.db('inv_vendors').whereRaw('LOWER(name) = ?', [key]);
        if (byName.length === 1) vendor = byName[0];
        else if (byName.length > 1) vendor = 'AMBIGUOUS';
      }
      const result = vendor || 'NOT_FOUND';
      vendorCache.set(key, result);
      return result;
    }
    // Item-code lookup, in order: 1) exact item code, 2) exact item name,
    // 3) normalized item code, 4) normalized item name/display name
    // (normalizeForMatch: NFC, accents stripped so "Ö" = "O", ®/™/© dropped,
    // all whitespace incl. non-breaking spaces dropped, case-insensitive).
    // Stops at the first step that finds anything (a unique hit
    // resolves it, more than one hit is reported as ambiguous and never
    // guessed) — later steps never run once an earlier one matched. Steps 3/4
    // exist because Excel's spacing/symbols around item names/codes often
    // don't exactly match what's saved in the ERP (e.g. "Model R - X" vs
    // "Model R- X", or "ÖLFLEX® UNIPLUS" vs "OLFLEX UNIPLUS") — this is a read-only comparison; nothing is ever written
    // back to inv_items.
    let allItemsForSpacingFallback = null;
    async function getAllItemsForSpacingFallback() {
      if (!allItemsForSpacingFallback) {
        allItemsForSpacingFallback = await req.db('inv_items').select('id', 'item_code', 'name', 'display_name');
      }
      return allItemsForSpacingFallback;
    }
    const itemCache = new Map();
    async function resolveItem(code) {
      const raw = String(code).trim();
      const key = raw.toLowerCase();
      if (itemCache.has(key)) return itemCache.get(key);

      let result = null;

      // Step 1: exact item code (case-insensitive)
      let rows = await req.db('inv_items').whereRaw('LOWER(item_code) = ?', [key]);
      if (rows.length === 1) result = { item: rows[0] };
      else if (rows.length > 1) result = { ambiguous: true, candidates: rows };

      // Step 2: exact item name (case-insensitive)
      if (!result) {
        rows = await req.db('inv_items').whereRaw('LOWER(name) = ?', [key]);
        if (rows.length === 1) result = { item: rows[0] };
        else if (rows.length > 1) result = { ambiguous: true, candidates: rows };
      }

      // Steps 3 & 4: normalized comparison — compared in memory against every item
      // (cached once per import, not refetched per row)
      if (!result) {
        const noSpaceKey = normalizeForMatch(raw);
        const allItems = await getAllItemsForSpacingFallback();

        // Step 3: item code, normalized
        let candidates = allItems.filter((it) => it.item_code && normalizeForMatch(it.item_code) === noSpaceKey);
        if (candidates.length === 1) {
          result = { item: candidates[0], matchedBySpacing: true, matchedValue: candidates[0].item_code };
        } else if (candidates.length > 1) {
          result = { ambiguous: true, candidates };
        }

        // Step 4: item name OR display name, normalized (one combined step)
        if (!result) {
          candidates = allItems.filter((it) =>
            (it.name && normalizeForMatch(it.name) === noSpaceKey) ||
            (it.display_name && normalizeForMatch(it.display_name) === noSpaceKey));
          if (candidates.length === 1) {
            const matched = candidates[0];
            const matchedValue = (matched.name && normalizeForMatch(matched.name) === noSpaceKey)
              ? matched.name
              : matched.display_name;
            result = { item: matched, matchedBySpacing: true, matchedValue };
          } else if (candidates.length > 1) {
            result = { ambiguous: true, candidates };
          }
        }
      }

      // Not found: suggest the closest existing items so the difference is
      // easy to spot.
      const final = result || {
        notFound: true,
        suggestions: closestItemLabels(raw, await getAllItemsForSpacingFallback()),
      };
      itemCache.set(key, final);
      return final;
    }

    const resolvedVendorByRow = new Map(); // rowNumber -> vendor row (only set when resolved cleanly)
    const resolvedItemByRow = new Map();
    for (const row of rows) {
      if (row.vendorCode && String(row.vendorCode).trim()) {
        const vendor = await resolveVendor(row.vendorCode);
        if (vendor === 'NOT_FOUND') addError(row.rowNumber, 'vendorCode', `Vendor code ${row.vendorCode} not found`);
        else if (vendor === 'AMBIGUOUS') addError(row.rowNumber, 'vendorCode', `Vendor name ${row.vendorCode} matches more than one vendor`);
        else resolvedVendorByRow.set(row.rowNumber, vendor);
      }
      if (row.itemCode && String(row.itemCode).trim()) {
        const resolved = await resolveItem(row.itemCode);
        if (resolved.notFound) {
          const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : '';
          addError(row.rowNumber, 'itemCode', `Item code ${row.itemCode} not found.${hint}`);
        } else if (resolved.ambiguous) {
          const names = resolved.candidates.map((c) => c.item_code || c.name).join(', ');
          addError(row.rowNumber, 'itemCode', `Matches more than one item: ${names}`);
        } else {
          resolvedItemByRow.set(row.rowNumber, resolved.item);
          if (resolved.matchedBySpacing) {
            addWarning(row.rowNumber, 'itemCode', `Matched '${row.itemCode}' to existing item '${resolved.matchedValue}'`);
          }
        }
      }
    }

    // ── PO number must not already exist ──────────────────────────────────
    for (const group of groups.values()) {
      const existing = await req.db('inv_purchases')
        .whereRaw('LTRIM(RTRIM(LOWER(po_number))) = ?', [normalizePoNumber(group.poNumber)]).first();
      if (existing) {
        for (const row of group.rows) addError(row.rowNumber, 'poNumber', `PO number "${group.poNumber}" already exists`);
      }
    }

    errors.sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
    warnings.sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
    const summary = { purchases: groups.size, lines: rows.length };

    if (dryRun) {
      return res.json({ valid: errors.length === 0, summary, errors, warnings, created: [] });
    }
    if (errors.length > 0) {
      return res.status(400).json({ valid: false, summary, errors, warnings, created: [] });
    }

    // ── Clean file — create every PO + its lines in ONE transaction, so a
    // partial-file failure (e.g. a genuine race on a PO number) never leaves
    // some purchases created and others missing ──
    const created = [];
    try {
      await req.db.transaction(async (trx) => {
        for (const group of groups.values()) {
          // Re-check right before inserting — the check above ran before this
          // transaction opened, so another request could have created the
          // same PO number in between. isImportUniqueViolation below is the
          // real atomic backstop once a unique index exists.
          const existing = await trx('inv_purchases')
            .whereRaw('LTRIM(RTRIM(LOWER(po_number))) = ?', [normalizePoNumber(group.poNumber)]).first();
          if (existing) throw Object.assign(new Error(`PO number "${group.poNumber}" already exists`), { isImportDuplicate: true });

          const first = group.rows[0];
          const vendor = resolvedVendorByRow.get(first.rowNumber);
          const id = 'po_' + Date.now() + Math.random().toString(36).slice(2, 8);
          const currency = (first.currency && String(first.currency).trim()) || vendor.currency || 'INR';
          await trx('inv_purchases').insert({
            id, po_number: group.poNumber, vendor_id: vendor.id, status: 'pending',
            order_date: parseImportDate(first.purchaseDate) || new Date(),
            invoice_number: (first.invoiceNumber && String(first.invoiceNumber).trim()) || null,
            currency, notes: null, created_by: req.user?.userId || null,
          });
          for (const row of group.rows) {
            const item = resolvedItemByRow.get(row.rowNumber);
            await trx('inv_purchase_items').insert({
              id: 'poi_' + Date.now() + Math.random().toString(36).slice(2, 6),
              purchase_id: id, item_id: item.id,
              vendor_item_code: row.vendorItemCode || null,
              quantity_ordered: row.quantity,
              unit_cost: row.unitCost || 0,
              freight_cost: row.freightCharges || 0,
              import_charges: row.importCharges || 0,
              lead_time_days: row.leadTimeDays || null,
            });
          }
          created.push({ id, poNumber: group.poNumber });
        }
      });
    } catch (e) {
      if (e.isImportDuplicate || isImportUniqueViolation(e)) {
        return res.status(400).json({
          valid: false, summary, created: [], warnings,
          errors: [{ rowNumber: null, column: 'poNumber', message: e.message || 'A duplicate PO number was found during import.' }],
        });
      }
      throw e;
    }

    for (const c of created) {
      const saved = await req.db('inv_purchases').where({ id: c.id }).first();
      req.io.to(req.company.slug).emit('inv:purchase_created', mapPurchase(saved));
    }
    res.json({ valid: true, summary, errors: [], warnings, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /purchases/:id/items — add one or more brand-new line items to an
// EXISTING purchase, from the Edit Purchase modal. Distinct from
// PATCH /purchases/:purchaseId/items/:lineId above, which only edits a line
// that's already there — until now there was no way to add a new one once
// the PO itself had already been created. Body: { lines: [{ itemId,
// quantityOrdered, unitCost?, freightCost?, importCharges?, leadTimeDays?,
// vendorItemCode? }, ...] } — same line shape POST /purchases itself takes.
router.post('/purchases/:id/items', async (req, res) => {
  try {
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'cancelled') return res.status(400).json({ error: 'Purchase was cancelled.' });

    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'At least one line item is required' });
    }
    for (const line of lines) {
      if (!line.itemId || line.quantityOrdered == null || Number(line.quantityOrdered) <= 0) {
        return res.status(400).json({ error: 'Each line needs a valid itemId and a positive quantityOrdered' });
      }
    }
    const itemIds = [...new Set(lines.map(l => l.itemId))];
    const foundItems = await req.db('inv_items').whereIn('id', itemIds);
    if (foundItems.length !== itemIds.length) {
      const foundIds = new Set(foundItems.map(i => i.id));
      const missing = itemIds.find(id => !foundIds.has(id));
      return res.status(400).json({ error: `Item not found: ${missing}` });
    }

    const createdIds = [];
    for (const line of lines) {
      const lineId = 'poi_' + Date.now() + Math.random().toString(36).slice(2, 6);
      await req.db('inv_purchase_items').insert({
        id: lineId, purchase_id: req.params.id, item_id: line.itemId,
        vendor_item_code: line.vendorItemCode || null,
        quantity_ordered: line.quantityOrdered,
        unit_cost: line.unitCost || 0,
        freight_cost: line.freightCost || 0,
        import_charges: line.importCharges || 0,
        lead_time_days: line.leadTimeDays || null,
      });
      createdIds.push(lineId);
    }

    // A newly-added, not-yet-received line means the purchase as a whole is
    // no longer fully received (even if it was before) — recompute status
    // the same way /receive-lines does, so a PO doesn't stay marked
    // "received" while it actually has real outstanding quantity on it.
    const refreshedLines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const totalOrdered = refreshedLines.reduce((s, l) => s + Number(l.quantity_ordered), 0);
    const totalReceived = refreshedLines.reduce((s, l) => s + Number(l.quantity_received || 0), 0);
    const newStatus = totalReceived <= 0 ? 'pending' : (totalReceived >= totalOrdered ? 'received' : 'partial');
    if (newStatus !== purchase.status) {
      await req.db('inv_purchases').where({ id: req.params.id }).update({ status: newStatus, updated_at: new Date() });
    }

    const savedPurchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('inv:purchase_updated', mapPurchase(savedPurchase));
    res.json({ ...mapPurchase(savedPurchase), items: refreshedLines.map(mapPurchaseItem) });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
    if (b.currency !== undefined) updates.currency = b.currency;
    // Manual override — /receive and /receive-lines already auto-stamp this to
    // "now" when a purchase is marked received, but the Edit Purchase modal
    // needs to let someone correct it to the real delivery date after the fact.
    if (b.receivedDate !== undefined) updates.received_date = b.receivedDate;
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

    // Real currency conversion, fetched ONCE here (an external API call has
    // no business running inside the DB transaction below), using the rate
    // as of the PO's own order_date — not today's rate; see
    // utils/currencyConvert.js for why. A purchase already in INR skips
    // this entirely (fxRate stays 1, zero behavior change). This is the
    // fix for the real incident where a non-INR purchase's cost was stored
    // completely unconverted.
    let fxRate = 1;
    if (purchase.currency && purchase.currency !== BASE_CURRENCY) {
      try {
        fxRate = await getHistoricalRate(purchase.currency, new Date(purchase.order_date));
      } catch (e) {
        return res.status(502).json({ error: `Couldn't fetch a real ${purchase.currency}->${BASE_CURRENCY} exchange rate — try again shortly. (${e.message})` });
      }
    }

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
          const landedUnitCost = (Number(line.unit_cost || 0) * fxRate * Number(line.quantity_ordered)
            + Number(line.freight_cost || 0) * fxRate + Number(line.import_charges || 0) * fxRate)
            / Number(line.quantity_ordered);
          const lotId = await createLot(trx, {
            itemId: line.item_id,
            lotRef: (lotRefs && lotRefs[line.id]) || `${purchase.po_number}-${line.id.slice(-6)}`,
            vendorId: purchase.vendor_id, purchaseItemId: line.id,
            quantity: outstanding, unitCost: landedUnitCost,
            receivedDate: new Date(), source: 'purchase',
            invoiceNumber: typeof invoiceNumber === 'string' ? invoiceNumber.trim() : null,
          });
          await createSerialUnitsForLot(trx, { itemId: line.item_id, lotId, purchaseItemId: line.id, quantity: outstanding });
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
// Body: { lines: [{ purchaseItemId, quantityReceived, previousQuantityReceived? }], invoiceNumber? }
// invoiceNumber is required whenever at least one line's received quantity
// goes UP (a new delivery) and is stamped on every lot this call creates —
// so each partial receipt keeps its own invoice. Pure reductions/no-ops
// don't need one.
router.post('/purchases/:id/receive-lines', async (req, res) => {
  try {
    const { lines } = req.body;
    const invoiceNumber = typeof req.body.invoiceNumber === 'string' ? req.body.invoiceNumber.trim() : '';
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines is required' });
    const purchase = await req.db('inv_purchases').where({ id: req.params.id }).first();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'cancelled') return res.status(400).json({ error: 'Purchase was cancelled.' });

    // Same real conversion as /receive above — fetched once, before the
    // transaction, using the rate as of the PO's order_date.
    let fxRate = 1;
    if (purchase.currency && purchase.currency !== BASE_CURRENCY) {
      try {
        fxRate = await getHistoricalRate(purchase.currency, new Date(purchase.order_date));
      } catch (e) {
        return res.status(502).json({ error: `Couldn't fetch a real ${purchase.currency}->${BASE_CURRENCY} exchange rate — try again shortly. (${e.message})` });
      }
    }

    const existingLines = await req.db('inv_purchase_items').where({ purchase_id: req.params.id });
    const touchedItemIds = new Set();

    const hasIncrease = lines.some(update => {
      const line = existingLines.find(l => l.id === update.purchaseItemId);
      if (!line) return false;
      const newReceived = Math.max(0, Math.min(Number(line.quantity_ordered), Number(update.quantityReceived || 0)));
      return newReceived > Number(line.quantity_received || 0);
    });
    if (hasIncrease && !invoiceNumber) {
      return res.status(400).json({ error: 'Invoice number is required when received quantity is increased.', code: 'INVOICE_NUMBER_REQUIRED' });
    }
    if (invoiceNumber.length > 100) return res.status(400).json({ error: 'Invoice number must be 100 characters or fewer.' });

    // Optional optimistic-concurrency guard: the caller can send the
    // quantityReceived its form was loaded with. If the line has moved since
    // (another save, another tab, a stale client cache), reject instead of
    // silently treating the stale form value as a reduction and reversing
    // stock that really was received.
    const stale = lines.find(update => {
      if (update.previousQuantityReceived === undefined || update.previousQuantityReceived === null) return false;
      const line = existingLines.find(l => l.id === update.purchaseItemId);
      return line && Number(update.previousQuantityReceived) !== Number(line.quantity_received || 0);
    });
    if (stale) {
      return res.status(409).json({ error: 'Received quantities were changed since this form was opened. Reload the purchase and try again.', code: 'RECEIVED_QUANTITY_CHANGED' });
    }

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
          const landedUnitCost = (Number(line.unit_cost || 0) * fxRate * Number(line.quantity_ordered)
            + Number(line.freight_cost || 0) * fxRate + Number(line.import_charges || 0) * fxRate)
            / Number(line.quantity_ordered);
          const lotId = await createLot(trx, {
            itemId: line.item_id,
            lotRef: `${purchase.po_number || purchase.id}-${line.id.slice(-6)}`,
            vendorId: purchase.vendor_id, purchaseItemId: line.id,
            quantity: delta, unitCost: landedUnitCost,
            receivedDate: new Date(), source: 'purchase',
            invoiceNumber,
          });
          await createSerialUnitsForLot(trx, { itemId: line.item_id, lotId, purchaseItemId: line.id, quantity: delta });
        } else {
          // Receiving was reduced (e.g. correcting an over-receipt) — consume
          // back out of that item's stock. This is a rare correction path, so
          // we accept it may touch a different (newer) lot than the one this
          // receipt originally created; recomputeItemStock keeps totals correct.
          await consumeStockFIFO(trx, line.item_id, Math.abs(delta));
          // Mirror the correction on serial units — only remove ones nobody's
          // assigned a serial to yet (an already-assigned serial reflects a
          // real physical unit someone recorded; deleting that silently would
          // be data loss, so those are left for a human to sort out by hand).
          const removable = await trx('inv_purchase_serial_units')
            .where({ item_id: line.item_id }).whereNull('serial_number')
            .orderBy('unit_number', 'desc').limit(Math.round(Math.abs(delta)));
          if (removable.length) {
            await trx('inv_purchase_serial_units').whereIn('id', removable.map(r => r.id)).delete();
          }
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
      if (lotIds.length) await trx('inv_purchase_serial_units').whereIn('lot_id', lotIds).delete();
      if (lotIds.length) await trx('inv_stock_lots').whereIn('id', lotIds).delete();
      if (lineIds.length) await trx('inv_purchase_items').whereIn('id', lineIds).delete();
      await trx('inv_purchases').where({ id: req.params.id }).delete();
      for (const itemId of itemIds) await recomputeItemStock(trx, itemId);
    });

    req.io.to(req.company.slug).emit('inv:purchase_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Serial units (traceability for purchased, serial_tracked items) ──────────
// Complements Manufacturing's mfg_assembly_units/serial-assignment for BUILT
// units — this is for items received as-is via a Purchase Order that are
// individually serial numbered (inv_items.serial_tracked). Rows here are
// auto-created (serial_number NULL) by /receive and /receive-lines above.

// GET /api/:slug/inventory/serial-units — grouped by item, for the
// Traceability page to list alongside Manufacturing's assembly groups.
router.get('/serial-units', async (req, res) => {
  try {
    const units = await req.db('inv_purchase_serial_units').orderBy('unit_number', 'asc');
    const itemIds = [...new Set(units.map(u => u.item_id))];
    const items = itemIds.length ? await req.db('inv_items').whereIn('id', itemIds) : [];
    const itemById = Object.fromEntries(items.map(i => [i.id, i]));

    const byItem = {};
    for (const u of units) {
      if (!byItem[u.item_id]) {
        const item = itemById[u.item_id];
        byItem[u.item_id] = { itemId: u.item_id, itemName: item?.name || 'Unknown item', units: [] };
      }
      byItem[u.item_id].units.push(mapSerialUnit(u));
    }
    res.json(Object.values(byItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/inventory/items/:id/serial-units — body: { serialNumber? }.
// Manual add, for stock that predates this item being marked serial_tracked
// (or any other case where a unit didn't come through /receive or
// /receive-lines) — not tied to a specific lot, unlike the auto-created rows.
router.post('/items/:id/serial-units', async (req, res) => {
  try {
    const item = await req.db('inv_items').where({ id: req.params.id }).first();
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.serial_tracked) return res.status(400).json({ error: 'This item is not marked serial_tracked.' });

    const { serialNumber } = req.body;
    if (serialNumber) {
      const clash = await req.db('inv_purchase_serial_units').where({ serial_number: serialNumber }).first();
      if (clash) return res.status(400).json({ error: `Serial number "${serialNumber}" is already in use` });
      const clashAssembly = await req.db('mfg_assembly_units').where({ serial_number: serialNumber }).first();
      if (clashAssembly) return res.status(400).json({ error: `Serial number "${serialNumber}" is already in use` });
    }

    const last = await req.db('inv_purchase_serial_units').where({ item_id: item.id }).orderBy('unit_number', 'desc').first();
    const id = 'psu_' + Date.now() + Math.random().toString(36).slice(2, 6);
    await req.db('inv_purchase_serial_units').insert({
      id, item_id: item.id, lot_id: null, purchase_item_id: null,
      unit_number: last ? last.unit_number + 1 : 1, serial_number: serialNumber || null,
    });
    const saved = await req.db('inv_purchase_serial_units').where({ id }).first();
    req.io.to(req.company.slug).emit('inv:serial_unit_updated', mapSerialUnit(saved));
    res.json(mapSerialUnit(saved));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/:slug/inventory/serial-units/:unitId — body: { serialNumber }.
// Uniqueness is checked against BOTH this table and mfg_assembly_units — a
// real-world serial number should never collide across the two, even though
// they're separate tables for purchased-vs-built units.
router.patch('/serial-units/:unitId', async (req, res) => {
  try {
    const { serialNumber } = req.body;
    if (serialNumber) {
      const clash = await req.db('inv_purchase_serial_units')
        .where({ serial_number: serialNumber }).andWhereNot({ id: req.params.unitId }).first();
      if (clash) return res.status(400).json({ error: `Serial number "${serialNumber}" is already in use` });
      const clashAssembly = await req.db('mfg_assembly_units').where({ serial_number: serialNumber }).first();
      if (clashAssembly) return res.status(400).json({ error: `Serial number "${serialNumber}" is already in use` });
    }
    await req.db('inv_purchase_serial_units').where({ id: req.params.unitId }).update({ serial_number: serialNumber || null });
    const saved = await req.db('inv_purchase_serial_units').where({ id: req.params.unitId }).first();
    if (!saved) return res.status(404).json({ error: 'Serial unit not found' });
    req.io.to(req.company.slug).emit('inv:serial_unit_updated', mapSerialUnit(saved));
    res.json(mapSerialUnit(saved));
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