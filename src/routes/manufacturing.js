const express = require('express');
const router = express.Router();
const { recomputeItemStock, consumeStockFIFO, createLot } = require('../utils/stockLots');

// ── Row mappers ────────────────────────────────────────────────────────────────
const mapBom = (r) => r && ({
  id: r.id, name: r.name, productItemId: r.product_item_id, notes: r.notes,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapBomLine = (r) => r && ({
  id: r.id, bomId: r.bom_id, componentItemId: r.component_item_id,
  quantityPerUnit: Number(r.quantity_per_unit),
});
const mapAssembly = (r) => r && ({
  id: r.id, assemblyNumber: r.assembly_number, name: r.name,
  bomId: r.bom_id, productItemId: r.product_item_id,
  quantityBuilt: Number(r.quantity_built),
  unitCost: r.unit_cost != null ? Number(r.unit_cost) : null,
  totalCost: r.total_cost != null ? Number(r.total_cost) : null,
  customerPoNumber: r.customer_po_number,
  status: r.status, notes: r.notes,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapAssemblyUnit = (r) => r && ({
  id: r.id, assemblyId: r.assembly_id, unitNumber: r.unit_number,
  serialNumber: r.serial_number, outputLotId: r.output_lot_id,
  sold: !!r.sold, createdAt: r.created_at,
});
const mapAssemblyItem = (r) => r && ({
  id: r.id, assemblyId: r.assembly_id, assemblyUnitId: r.assembly_unit_id,
  componentItemId: r.component_item_id, consumedLotId: r.consumed_lot_id,
  quantity: Number(r.quantity), consumedUnitId: r.consumed_unit_id,
});

// ── BOMs ──────────────────────────────────────────────────────────────────────

router.get('/boms', async (req, res) => {
  try {
    const rows = await req.db('mfg_boms').orderBy('name', 'asc');
    res.json(rows.map(mapBom));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/boms/:id', async (req, res) => {
  try {
    const bom = await req.db('mfg_boms').where({ id: req.params.id }).first();
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const lines = await req.db('mfg_bom_lines').where({ bom_id: req.params.id });
    res.json({ ...mapBom(bom), lines: lines.map(mapBomLine) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/boms', async (req, res) => {
  try {
    const { name, productItemId, notes, lines } = req.body;
    if (!name || !productItemId) return res.status(400).json({ error: 'name and productItemId are required' });
    // Lines are optional at creation time — the BOM Builder's two-panel flow
    // creates an empty BOM first, then components get added one at a time
    // via "+ Add Component", so requiring a line up front just forces every
    // caller (including this app's own frontend) into an awkward placeholder
    // insert-then-clear dance.
    const product = await req.db('inv_items').where({ id: productItemId }).first();
    if (!product) return res.status(400).json({ error: 'Product item not found' });

    // One BOM per finished good (mfg_boms.product_item_id is UNIQUE) — check
    // up front so the person gets a clear message pointing at the existing
    // BOM, instead of a raw SQL constraint-violation error.
    const existing = await req.db('mfg_boms').where({ product_item_id: productItemId }).first();
    if (existing) {
      return res.status(400).json({ error: `"${product.name}" already has a BOM ("${existing.name}") — edit that one instead of creating a second.` });
    }

    const id = 'bom_' + Date.now();
    await req.db('mfg_boms').insert({
      id, name, product_item_id: productItemId,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    for (const line of (lines || [])) {
      if (!line.componentItemId || !line.quantityPerUnit) continue;
      await req.db('mfg_bom_lines').insert({
        id: 'boml_' + Date.now() + Math.random().toString(36).slice(2, 6),
        bom_id: id, component_item_id: line.componentItemId,
        quantity_per_unit: line.quantityPerUnit,
      });
    }
    const saved = await req.db('mfg_boms').where({ id }).first();
    const savedLines = await req.db('mfg_bom_lines').where({ bom_id: id });
    req.io.to(req.company.slug).emit('mfg:bom_created', mapBom(saved));
    res.json({ ...mapBom(saved), lines: savedLines.map(mapBomLine) });
  } catch (e) {
    // Safety net in case of a race (two requests for the same product
    // landing between the pre-check and the insert) — translate the raw
    // SQL unique-constraint message into something readable.
    if (/UQ_mfg_boms_product/i.test(e.message)) {
      return res.status(400).json({ error: 'This item already has a BOM. Refresh and edit the existing one instead.' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.patch('/boms/:id', async (req, res) => {
  try {
    const bom = await req.db('mfg_boms').where({ id: req.params.id }).first();
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const { name, notes, lines } = req.body;
    const updates = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (notes !== undefined) updates.notes = notes;
    await req.db('mfg_boms').where({ id: req.params.id }).update(updates);
    if (Array.isArray(lines)) {
      await req.db('mfg_bom_lines').where({ bom_id: req.params.id }).delete();
      for (const line of lines) {
        if (!line.componentItemId || !line.quantityPerUnit) continue;
        await req.db('mfg_bom_lines').insert({
          id: 'boml_' + Date.now() + Math.random().toString(36).slice(2, 6),
          bom_id: req.params.id, component_item_id: line.componentItemId,
          quantity_per_unit: line.quantityPerUnit,
        });
      }
    }
    const saved = await req.db('mfg_boms').where({ id: req.params.id }).first();
    const savedLines = await req.db('mfg_bom_lines').where({ bom_id: req.params.id });
    req.io.to(req.company.slug).emit('mfg:bom_updated', mapBom(saved));
    res.json({ ...mapBom(saved), lines: savedLines.map(mapBomLine) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/boms/:id', async (req, res) => {
  try {
    const inUse = await req.db('mfg_assemblies').where({ bom_id: req.params.id }).first();
    if (inUse) return res.status(400).json({ error: 'This BOM has assembly history and cannot be deleted.' });
    await req.db('mfg_bom_lines').where({ bom_id: req.params.id }).delete();
    await req.db('mfg_boms').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('mfg:bom_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/manufacturing/boms/:id/check?quantity=N
router.get('/boms/:id/check', async (req, res) => {
  try {
    const bom = await req.db('mfg_boms').where({ id: req.params.id }).first();
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const quantity = Number(req.query.quantity || 1);
    const lines = await req.db('mfg_bom_lines').where({ bom_id: req.params.id });
    const results = [];
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.component_item_id }).first();
      const required = Number(line.quantity_per_unit) * quantity;
      const available = Number(item?.stock || 0);
      results.push({
        componentItemId: line.component_item_id,
        componentName: item?.name || 'Unknown',
        required, available, sufficient: available >= required,
      });
    }
    res.json({ quantity, canBuild: results.every(r => r.sufficient), lines: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Assemblies ────────────────────────────────────────────────────────────────

// GET /api/:slug/manufacturing/boms/:id/vendor-check?quantity=N
// Per-component breakdown of which vendors currently have enough lot stock
// remaining to cover this build — a DISPLAY HINT for the "Vendor Source"
// picker in Create Assembly. Consumption itself stays FIFO-pooled across all
// vendors (see POST /assemblies below); this endpoint doesn't change that,
// it only tells the user where the stock they're about to consume actually
// came from, so they can flag a preferred/known-good batch if it matters.
router.get('/boms/:id/vendor-check', async (req, res) => {
  try {
    const bom = await req.db('mfg_boms').where({ id: req.params.id }).first();
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const quantity = Number(req.query.quantity || 1);
    const lines = await req.db('mfg_bom_lines').where({ bom_id: req.params.id });
    const results = [];
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.component_item_id }).first();
      const required = Number(line.quantity_per_unit) * quantity;
      const lots = await req.db('inv_stock_lots')
        .where({ item_id: line.component_item_id })
        .andWhere('quantity_remaining', '>', 0);
      const byVendor = {};
      for (const lot of lots) {
        const key = lot.vendor_id || '__unassigned__';
        byVendor[key] = (byVendor[key] || 0) + Number(lot.quantity_remaining);
      }
      const vendorRows = await req.db('inv_vendors').whereIn('id', Object.keys(byVendor).filter(k => k !== '__unassigned__'));
      const vendorName = (id) => vendorRows.find(v => v.id === id)?.name;
      const vendors = Object.entries(byVendor).map(([vendorId, available]) => ({
        vendorId: vendorId === '__unassigned__' ? null : vendorId,
        vendorName: vendorId === '__unassigned__' ? 'Unassigned stock' : (vendorName(vendorId) || 'Unknown vendor'),
        available, sufficient: available >= required,
      })).sort((a, b) => b.available - a.available);
      results.push({
        componentItemId: line.component_item_id,
        componentName: item?.name || 'Unknown',
        required,
        totalAvailable: Number(item?.stock || 0),
        vendors,
        anyVendorSufficient: vendors.some(v => v.sufficient),
      });
    }
    res.json({ quantity, lines: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assemblies', async (req, res) => {
  try {
    // A 'reversed' assembly is this app's soft-delete — once reversed it
    // shouldn't keep appearing in the list (its stock effects are undone
    // and its units/items are gone), same as any other deleted record.
    // Pass ?includeReversed=1 to see them anyway (e.g. an audit view).
    let q = req.db('mfg_assemblies');
    if (!req.query.includeReversed) q = q.whereNot({ status: 'reversed' });
    const rows = await q.orderBy('created_at', 'desc');
    res.json(rows.map(mapAssembly));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assemblies/:id', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    const units = await req.db('mfg_assembly_units').where({ assembly_id: req.params.id }).orderBy('unit_number', 'asc');
    const items = await req.db('mfg_assembly_items').where({ assembly_id: req.params.id });

    // Enrich each consumption row with the vendor that lot came from, for
    // the "Source" column in the Assembly page's expandable history.
    const lotIds = [...new Set(items.map(i => i.consumed_lot_id).filter(Boolean))];
    const lots = lotIds.length ? await req.db('inv_stock_lots').whereIn('id', lotIds) : [];
    const vendorIds = [...new Set(lots.map(l => l.vendor_id).filter(Boolean))];
    const vendors = vendorIds.length ? await req.db('inv_vendors').whereIn('id', vendorIds) : [];
    const lotVendorName = (lotId) => {
      const lot = lots.find(l => l.id === lotId);
      if (!lot) return 'Not tracked';
      if (!lot.vendor_id) return lot.source === 'manual' ? 'Manual adjustment' : 'Unassigned stock';
      return vendors.find(v => v.id === lot.vendor_id)?.name || 'Unknown vendor';
    };
    const itemsEnriched = items.map(i => ({ ...mapAssemblyItem(i), source: lotVendorName(i.consumed_lot_id) }));

    // Per-component summary (Item ID / Name / Qty per Unit / Total Used /
    // Source) — collapses the per-unit rows into one row per component,
    // matching the reference screenshot's "Components Used" table.
    const byComponent = {};
    for (const i of itemsEnriched) {
      const key = i.componentItemId;
      if (!byComponent[key]) byComponent[key] = { componentItemId: key, quantityPerUnit: i.quantity, totalUsed: 0, sources: new Set() };
      byComponent[key].totalUsed += Number(i.quantity);
      byComponent[key].sources.add(i.source);
    }
    const componentsUsed = Object.values(byComponent).map(c => ({
      ...c, source: [...c.sources].join(', '), sources: undefined,
    }));

    res.json({ ...mapAssembly(asm), units: units.map(mapAssemblyUnit), items: itemsEnriched, componentsUsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/manufacturing/units/:serial — traceability: look up a unit by serial
router.get('/units/:serial', async (req, res) => {
  try {
    const unit = await req.db('mfg_assembly_units').where({ serial_number: req.params.serial }).first();
    if (!unit) return res.status(404).json({ error: 'No unit found with that serial number' });
    const asm = await req.db('mfg_assemblies').where({ id: unit.assembly_id }).first();
    const items = await req.db('mfg_assembly_items').where({ assembly_unit_id: unit.id });
    res.json({ unit: mapAssemblyUnit(unit), assembly: mapAssembly(asm), components: items.map(mapAssemblyItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/manufacturing/assemblies
// Body: { bomId, quantityBuilt, name, customerPoNumber, notes,
//          serialNumbers: ['SN001','SN002',...] (optional, one per unit) }
router.post('/assemblies', async (req, res) => {
  try {
    const { bomId, quantityBuilt, name, customerPoNumber, notes, serialNumbers } = req.body;
    if (!bomId || !quantityBuilt || Number(quantityBuilt) <= 0) {
      return res.status(400).json({ error: 'bomId and a positive quantityBuilt are required' });
    }
    const bom = await req.db('mfg_boms').where({ id: bomId }).first();
    if (!bom) return res.status(400).json({ error: 'BOM not found' });
    const lines = await req.db('mfg_bom_lines').where({ bom_id: bomId });
    if (!lines.length) return res.status(400).json({ error: 'This BOM has no component lines' });

    // Validate serials don't already exist
    if (Array.isArray(serialNumbers)) {
      for (const sn of serialNumbers) {
        if (!sn) continue;
        const exists = await req.db('mfg_assembly_units').where({ serial_number: sn }).first();
        if (exists) return res.status(400).json({ error: `Serial number "${sn}" is already in use` });
      }
    }

    // Pre-flight stock check
    const requirements = [];
    const shortfalls = [];
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.component_item_id }).first();
      const required = Number(line.quantity_per_unit) * Number(quantityBuilt);
      const available = Number(item?.stock || 0);
      requirements.push({ item, required, quantityPerUnit: Number(line.quantity_per_unit) });
      if (available < required) {
        shortfalls.push(`${item?.name || line.component_item_id}: need ${required}, have ${available}`);
      }
    }
    if (shortfalls.length) {
      return res.status(400).json({ error: 'Not enough stock: ' + shortfalls.join('; ') });
    }

    // Generate sequential assembly number
    const lastAsm = await req.db('mfg_assemblies').orderBy('created_at', 'desc').first();
    let nextNum = 1;
    if (lastAsm && lastAsm.assembly_number) {
      const match = lastAsm.assembly_number.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }
    const assemblyNumber = 'ASM-' + String(nextNum).padStart(4, '0');

    const assemblyId = 'asm_' + Date.now();
    const updatedItemIds = [];
    let outputLotId = null;

    await req.db.transaction(async (trx) => {
      let totalComponentCost = 0;

      // Consume stock FIFO for each component and record traceability
      for (const { item, required } of requirements) {
        const consumed = await consumeStockFIFO(trx, item.id, required);
        for (const c of consumed) {
          totalComponentCost += c.quantityConsumed * c.unitCost;
        }
        await recomputeItemStock(trx, item.id);
        updatedItemIds.push(item.id);
      }

      const unitCost = Number(quantityBuilt) > 0 ? totalComponentCost / Number(quantityBuilt) : 0;
      const totalCost = totalComponentCost;

      // Create the assembly record
      await trx('mfg_assemblies').insert({
        id: assemblyId, assembly_number: assemblyNumber,
        name: name || bom.name, bom_id: bomId,
        product_item_id: bom.product_item_id,
        quantity_built: quantityBuilt,
        unit_cost: unitCost, total_cost: totalCost,
        customer_po_number: customerPoNumber || null,
        status: 'completed', notes: notes || null,
        created_by: req.user?.userId || null,
      });

      // Create a stock lot for the finished product. createLot generates
      // its own internal id and returns it — it does not accept/honor a
      // caller-supplied id, so we must capture what it actually returns
      // rather than assume our own guessed id was used (using a guessed,
      // never-inserted id here previously broke the FK on
      // mfg_assembly_units.output_lot_id).
      outputLotId = await createLot(trx, {
        itemId: bom.product_item_id,
        lotRef: assemblyNumber,
        quantity: quantityBuilt,
        unitCost: unitCost,
        source: 'assembly',
        notes: `Built via assembly ${assemblyNumber}`,
      });
      await recomputeItemStock(trx, bom.product_item_id);
      updatedItemIds.push(bom.product_item_id);

      // Create per-unit rows
      for (let i = 1; i <= Number(quantityBuilt); i++) {
        const unitId = 'unit_' + assemblyId + '_' + i;
        const sn = Array.isArray(serialNumbers) && serialNumbers[i - 1]
          ? serialNumbers[i - 1] : null;
        await trx('mfg_assembly_units').insert({
          id: unitId, assembly_id: assemblyId,
          unit_number: i, serial_number: sn,
          output_lot_id: outputLotId, sold: 0,
        });

        // Per-unit component traceability: distribute each component's
        // consumed lots evenly across units
        for (const { item, quantityPerUnit } of requirements) {
          const consumed = await trx('inv_stock_lots')
            .where({ item_id: item.id })
            .orderBy('received_date', 'asc').orderBy('created_at', 'asc');
          // For traceability, record the first available lot as the source
          // (in a full implementation, you'd split by lot across units)
          const sourceLot = consumed[0];
          if (sourceLot) {
            await trx('mfg_assembly_items').insert({
              id: 'ai_' + unitId + '_' + item.id.slice(-6),
              assembly_id: assemblyId, assembly_unit_id: unitId,
              component_item_id: item.id,
              consumed_lot_id: sourceLot.id,
              quantity: quantityPerUnit,
            });
          }
        }
      }
    });

    // Broadcast updated stock
    for (const itemId of [...new Set(updatedItemIds)]) {
      const savedItem = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', {
        id: savedItem.id, stock: Number(savedItem.stock), name: savedItem.name,
      });
    }

    const savedAssembly = await req.db('mfg_assemblies').where({ id: assemblyId }).first();
    const savedUnits = await req.db('mfg_assembly_units').where({ assembly_id: assemblyId }).orderBy('unit_number', 'asc');
    req.io.to(req.company.slug).emit('mfg:assembly_created', mapAssembly(savedAssembly));
    res.json({ ...mapAssembly(savedAssembly), units: savedUnits.map(mapAssemblyUnit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/manufacturing/assemblies/:id/reverse
// PATCH /api/:slug/manufacturing/assemblies/:id
// Body: { name?, notes?, customerPoNumber?, quantityBuilt? }
// Editing quantityBuilt adjusts real stock: increasing consumes additional
// component stock and adds new units (same validation as a fresh build);
// decreasing returns component stock and removes the highest-numbered units
// (refusing if any of those units were already sold).
router.patch('/assemblies/:id', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    if (asm.status === 'reversed') return res.status(400).json({ error: 'This assembly was reversed and cannot be edited.' });
    const { name, notes, customerPoNumber, quantityBuilt } = req.body;

    const simpleUpdates = { updated_at: new Date() };
    if (name !== undefined) simpleUpdates.name = name;
    if (notes !== undefined) simpleUpdates.notes = notes;
    if (customerPoNumber !== undefined) simpleUpdates.customer_po_number = customerPoNumber;

    if (quantityBuilt !== undefined && Number(quantityBuilt) !== Number(asm.quantity_built)) {
      const newQty = Number(quantityBuilt);
      if (!newQty || newQty <= 0) return res.status(400).json({ error: 'quantityBuilt must be positive' });
      const delta = newQty - Number(asm.quantity_built);
      const bom = await req.db('mfg_boms').where({ id: asm.bom_id }).first();
      const lines = await req.db('mfg_bom_lines').where({ bom_id: asm.bom_id });

      await req.db.transaction(async (trx) => {
        if (delta > 0) {
          // Consume more stock for the additional units, same pre-flight
          // check pattern as a fresh build.
          const shortfalls = [];
          const requirements = [];
          for (const line of lines) {
            const item = await trx('inv_items').where({ id: line.component_item_id }).first();
            const required = Number(line.quantity_per_unit) * delta;
            const available = Number(item?.stock || 0);
            requirements.push({ item, required, quantityPerUnit: Number(line.quantity_per_unit) });
            if (available < required) shortfalls.push(`${item?.name || line.component_item_id}: need ${required}, have ${available}`);
          }
          if (shortfalls.length) throw new Error('Not enough stock to increase quantity: ' + shortfalls.join('; '));

          let addedComponentCost = 0;
          for (const { item, required } of requirements) {
            const consumed = await consumeStockFIFO(trx, item.id, required);
            for (const c of consumed) addedComponentCost += c.quantityConsumed * c.unitCost;
            await recomputeItemStock(trx, item.id);
          }
          const addedOutputLotId = await createLot(trx, {
            itemId: asm.product_item_id, lotRef: asm.assembly_number + '-adj',
            quantity: delta, unitCost: addedComponentCost / delta,
            source: 'assembly', notes: `Quantity increase on assembly ${asm.assembly_number}`,
          });
          await recomputeItemStock(trx, asm.product_item_id);

          const existingUnits = await trx('mfg_assembly_units').where({ assembly_id: req.params.id });
          let nextUnitNum = existingUnits.length + 1;
          for (let i = 0; i < delta; i++) {
            const unitId = 'unit_' + req.params.id + '_' + nextUnitNum;
            await trx('mfg_assembly_units').insert({ id: unitId, assembly_id: req.params.id, unit_number: nextUnitNum, output_lot_id: addedOutputLotId, sold: 0 });
            for (const { item, quantityPerUnit } of requirements) {
              const lot = await trx('inv_stock_lots').where({ item_id: item.id }).orderBy('received_date', 'asc').first();
              if (lot) {
                await trx('mfg_assembly_items').insert({
                  id: 'ai_' + unitId + '_' + item.id.slice(-6),
                  assembly_id: req.params.id, assembly_unit_id: unitId,
                  component_item_id: item.id, consumed_lot_id: lot.id, quantity: quantityPerUnit,
                });
              }
            }
            nextUnitNum++;
          }
          const newTotalCost = Number(asm.total_cost || 0) + addedComponentCost;
          simpleUpdates.quantity_built = newQty;
          simpleUpdates.total_cost = newTotalCost;
          simpleUpdates.unit_cost = newTotalCost / newQty;
        } else {
          // Decreasing: remove the highest-numbered units and return their
          // component stock, refusing if any of those units were sold.
          const removeCount = Math.abs(delta);
          const unitsToRemove = await trx('mfg_assembly_units')
            .where({ assembly_id: req.params.id }).orderBy('unit_number', 'desc').limit(removeCount);
          if (unitsToRemove.some(u => u.sold)) {
            throw new Error('Cannot reduce quantity: one or more of the units that would be removed have already been sold');
          }
          const unitIds = unitsToRemove.map(u => u.id);
          const itemsToRestore = await trx('mfg_assembly_items').whereIn('assembly_unit_id', unitIds);
          const restoreByLot = {};
          for (const ai of itemsToRestore) restoreByLot[ai.consumed_lot_id] = (restoreByLot[ai.consumed_lot_id] || 0) + Number(ai.quantity);
          for (const [lotId, qty] of Object.entries(restoreByLot)) {
            await trx('inv_stock_lots').where({ id: lotId }).increment('quantity_remaining', qty);
          }
          const componentItemIds = [...new Set(itemsToRestore.map(i => i.component_item_id))];
          for (const itemId of componentItemIds) await recomputeItemStock(trx, itemId);

          await trx('mfg_assembly_items').whereIn('assembly_unit_id', unitIds).delete();
          await trx('mfg_assembly_units').whereIn('id', unitIds).delete();

          // Shrink the finished-product output lot by the removed quantity.
          const outputLotId = unitsToRemove[0]?.output_lot_id;
          if (outputLotId) await trx('inv_stock_lots').where({ id: outputLotId }).decrement('quantity_remaining', removeCount);
          await recomputeItemStock(trx, asm.product_item_id);

          const removedCost = Number(asm.unit_cost || 0) * removeCount;
          const newTotalCost = Math.max(0, Number(asm.total_cost || 0) - removedCost);
          simpleUpdates.quantity_built = newQty;
          simpleUpdates.total_cost = newTotalCost;
          simpleUpdates.unit_cost = newQty > 0 ? newTotalCost / newQty : 0;
        }
      });
    }

    await req.db('mfg_assemblies').where({ id: req.params.id }).update(simpleUpdates);
    const saved = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('mfg:assembly_updated', mapAssembly(saved));
    res.json(mapAssembly(saved));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/:slug/manufacturing/units/:unitId
// Body: { serialNumber } — assign/update a unit's serial number, used by the
// Traceability page (serials no longer have to be entered at build time).
router.patch('/units/:unitId', async (req, res) => {
  try {
    const unit = await req.db('mfg_assembly_units').where({ id: req.params.unitId }).first();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    const { serialNumber } = req.body;
    if (serialNumber) {
      const clash = await req.db('mfg_assembly_units').where({ serial_number: serialNumber }).andWhereNot({ id: req.params.unitId }).first();
      if (clash) return res.status(400).json({ error: `Serial number "${serialNumber}" is already in use` });
    }
    await req.db('mfg_assembly_units').where({ id: req.params.unitId }).update({ serial_number: serialNumber || null });
    const saved = await req.db('mfg_assembly_units').where({ id: req.params.unitId }).first();
    req.io.to(req.company.slug).emit('mfg:unit_updated', mapAssemblyUnit(saved));
    res.json(mapAssemblyUnit(saved));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/assemblies/:id/reverse', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    if (asm.status === 'reversed') {
      // Could be a genuinely-already-reversed assembly (nothing left to do —
      // treat repeat calls as a harmless success), or it could be stuck from
      // an earlier attempt that set status='reversed' but died partway
      // through before actually deleting the units/items (the bug that
      // caused "already reversed" to show up on a row that was still
      // sitting in the list with real leftover data). Finish the cleanup in
      // that case instead of just erroring out again.
      const leftoverUnits = await req.db('mfg_assembly_units').where({ assembly_id: req.params.id });
      if (!leftoverUnits.length) {
        return res.json(mapAssembly(asm));
      }
      if (leftoverUnits.some(u => u.sold)) {
        return res.status(400).json({ error: 'Cannot finish reversing: one or more units from this assembly have been sold. Contact support — this assembly is in an inconsistent state.' });
      }
      // fall through to the normal reverse logic below to finish the cleanup
    } else {
      // Check no units have been sold
      const soldUnit = await req.db('mfg_assembly_units').where({ assembly_id: req.params.id, sold: 1 }).first();
      if (soldUnit) return res.status(400).json({ error: 'Cannot reverse: one or more units from this assembly have been sold' });
    }

    await req.db.transaction(async (trx) => {
      const units = await trx('mfg_assembly_units').where({ assembly_id: req.params.id });
      const items = await trx('mfg_assembly_items').where({ assembly_id: req.params.id });

      // mfg_assembly_units.output_lot_id references inv_stock_lots
      // (FK_mfg_au_lot) — the lot can't be deleted while a unit row still
      // points at it. Clear that reference first, then delete the units and
      // their per-component consumption rows, THEN the lots. Deleting the
      // lot before clearing/removing the referencing unit (the previous
      // order) hit the FK immediately. `units` and `items` were captured
      // above before any deletes, so the restore-stock step below still has
      // everything it needs even after these rows are gone.
      await trx('mfg_assembly_units').where({ assembly_id: req.params.id }).update({ output_lot_id: null });
      await trx('mfg_assembly_items').where({ assembly_id: req.params.id }).delete();
      await trx('mfg_assembly_units').where({ assembly_id: req.params.id }).delete();

      // Remove the finished-product lot(s) now that nothing references them
      const outputLotIds = [...new Set(units.map(u => u.output_lot_id).filter(Boolean))];
      if (outputLotIds.length) await trx('inv_stock_lots').whereIn('id', outputLotIds).delete();
      await recomputeItemStock(trx, asm.product_item_id);

      // Restore component stock by re-creating lots from the assembly_items
      // traceability captured before it was deleted.
      const restoreByLot = {};
      for (const ai of items) {
        restoreByLot[ai.consumed_lot_id] = (restoreByLot[ai.consumed_lot_id] || 0) + Number(ai.quantity);
      }
      for (const [lotId, qty] of Object.entries(restoreByLot)) {
        await trx('inv_stock_lots').where({ id: lotId }).increment('quantity_remaining', qty);
      }

      // Get unique component item ids
      const componentItemIds = [...new Set(items.map(i => i.component_item_id))];
      for (const itemId of componentItemIds) {
        await recomputeItemStock(trx, itemId);
      }

      await trx('mfg_assemblies').where({ id: req.params.id }).update({ status: 'reversed', updated_at: new Date() });
    });

    const saved = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('mfg:assembly_reversed', mapAssembly(saved));
    res.json(mapAssembly(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;