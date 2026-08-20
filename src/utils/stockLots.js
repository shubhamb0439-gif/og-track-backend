/**
 * Shared stock-lot logic. dbo.inv_items.stock is a MAINTAINED number, never
 * the source of truth — the real source of truth is the sum of that item's
 * dbo.inv_stock_lots.quantity_remaining. Every function here keeps those in
 * sync so the rest of the app can keep reading item.stock as a fast,
 * always-correct summary without recomputing it inline everywhere.
 */

/**
 * Recomputes and writes item.stock (sum of remaining lot quantities) and
 * item.avg_cost (weighted average across REMAINING lots only — an informational
 * display number, distinct from any individual lot's own fixed cost).
 * Call this after any operation that adds/removes lots or changes their
 * quantity_remaining. Works with either a plain db connection or a knex
 * transaction (`trx`) — just pass whichever you're already inside.
 */
async function recomputeItemStock(db, itemId) {
  const lots = await db('inv_stock_lots').where({ item_id: itemId }).andWhere('quantity_remaining', '>', 0);
  const stock = lots.reduce((sum, l) => sum + Number(l.quantity_remaining), 0);
  const totalValue = lots.reduce((sum, l) => sum + Number(l.quantity_remaining) * Number(l.unit_cost), 0);
  const avgCost = stock > 0 ? totalValue / stock : null;
  await db('inv_items').where({ id: itemId }).update({ stock, avg_cost: avgCost, updated_at: new Date() });
  return { stock, avgCost };
}

/**
 * Consumes `quantity` units of an item, oldest lot first (FIFO), across as
 * many lots as needed. Throws if the item's total remaining stock can't
 * cover the request — callers should check this BEFORE starting any related
 * inserts, but this also guards directly since it's the real source of truth.
 *
 * Returns an array of { lotId, quantityConsumed, unitCost } — one entry per
 * lot actually touched — so the caller can log exactly what was drawn from
 * (e.g. into inv_stock_issue_lots or mfg_assembly_line_lots).
 *
 * Does NOT call recomputeItemStock itself — callers do that once after all
 * their consumption for a given operation is done, to avoid redundant writes
 * when a single operation touches multiple items.
 */
async function consumeStockFIFO(db, itemId, quantity) {
  const need = Number(quantity);
  if (need <= 0) throw new Error('Quantity to consume must be positive');

  const lots = await db('inv_stock_lots')
    .where({ item_id: itemId })
    .andWhere('quantity_remaining', '>', 0)
    .orderBy('received_date', 'asc')
    .orderBy('created_at', 'asc');

  const totalAvailable = lots.reduce((sum, l) => sum + Number(l.quantity_remaining), 0);
  if (totalAvailable < need) {
    throw new Error(`Not enough stock: need ${need}, only ${totalAvailable} available across all lots`);
  }

  const consumed = [];
  let remaining = need;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.quantity_remaining));
    await db('inv_stock_lots').where({ id: lot.id }).update({
      quantity_remaining: Number(lot.quantity_remaining) - take,
    });
    consumed.push({ lotId: lot.id, quantityConsumed: take, unitCost: Number(lot.unit_cost) });
    remaining -= take;
  }
  return consumed;
}

// Below this tolerance, a remaining quantity is treated as zero — needed
// because these are floating-point JS numbers (DECIMAL(14,2) columns can
// carry fractional units, e.g. kg/m), and without it a run of many units
// could drift into an infinite loop chasing a residue like 1e-13.
const QTY_EPSILON = 1e-6;

/**
 * Splits a component's total FIFO consumption (the array consumeStockFIFO
 * returned) across the individual units being built, in the same oldest-lot-
 * first order — so each unit's own traceability reflects the lot(s) it
 * ACTUALLY drew from, not a re-guessed "oldest lot with any history" (the bug
 * this replaces: manufacturing.js used to ignore consumeStockFIFO's real
 * result and just re-query for `consumed[0]`, which didn't even check
 * quantity_remaining > 0).
 *
 * Returns an array of length `unitCount`; each entry is an array of
 * { lotId, quantity } — usually one entry, but more than one whenever that
 * unit's own quantityPerUnit share happens to straddle a lot boundary.
 *
 * `consumed` must sum to quantityPerUnit * unitCount (true by construction —
 * it's exactly what consumeStockFIFO(itemId, quantityPerUnit * unitCount)
 * returned for this same requirement).
 */
function distributeConsumptionAcrossUnits(consumed, quantityPerUnit, unitCount) {
  const perUnit = [];
  let lotIdx = 0;
  let lotRemaining = consumed.length ? Number(consumed[0].quantityConsumed) : 0;

  for (let u = 0; u < unitCount; u++) {
    let need = Number(quantityPerUnit);
    const rows = [];
    while (need > QTY_EPSILON && lotIdx < consumed.length) {
      const take = Math.min(need, lotRemaining);
      if (take > QTY_EPSILON) rows.push({ lotId: consumed[lotIdx].lotId, quantity: take });
      need -= take;
      lotRemaining -= take;
      if (lotRemaining <= QTY_EPSILON) {
        lotIdx++;
        lotRemaining = lotIdx < consumed.length ? Number(consumed[lotIdx].quantityConsumed) : 0;
      }
    }
    perUnit.push(rows);
  }
  return perUnit;
}

/**
 * Creates a new lot for an item (received stock, opening balance, or a
 * manual positive correction) and returns the created row's id.
 */
async function createLot(db, { itemId, lotRef, vendorId, purchaseItemId, quantity, unitCost, receivedDate, source, notes }) {
  const id = 'lot' + Date.now() + Math.random().toString(36).slice(2, 6);
  await db('inv_stock_lots').insert({
    id,
    item_id: itemId,
    lot_ref: lotRef || null,
    vendor_id: vendorId || null,
    purchase_item_id: purchaseItemId || null,
    quantity_received: quantity,
    quantity_remaining: quantity,
    unit_cost: unitCost,
    received_date: receivedDate || new Date(),
    source: source || 'manual',
    notes: notes || null,
  });
  return id;
}

module.exports = { recomputeItemStock, consumeStockFIFO, createLot, distributeConsumptionAcrossUnits };