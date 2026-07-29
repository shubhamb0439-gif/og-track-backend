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
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one component line is required' });
    const product = await req.db('inv_items').where({ id: productItemId }).first();
    if (!product) return res.status(400).json({ error: 'Product item not found' });

    const id = 'bom_' + Date.now();
    await req.db('mfg_boms').insert({
      id, name, product_item_id: productItemId,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    for (const line of lines) {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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

router.get('/assemblies', async (req, res) => {
  try {
    const rows = await req.db('mfg_assemblies').orderBy('created_at', 'desc');
    res.json(rows.map(mapAssembly));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assemblies/:id', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    const units = await req.db('mfg_assembly_units').where({ assembly_id: req.params.id }).orderBy('unit_number', 'asc');
    const items = await req.db('mfg_assembly_items').where({ assembly_id: req.params.id });
    res.json({ ...mapAssembly(asm), units: units.map(mapAssemblyUnit), items: items.map(mapAssemblyItem) });
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

      // Create a stock lot for the finished product
      const lotId = 'lot_asm_' + assemblyId;
      await createLot(trx, {
        itemId: bom.product_item_id,
        lotRef: assemblyNumber,
        quantity: quantityBuilt,
        unitCost: unitCost,
        source: 'assembly',
        notes: `Built via assembly ${assemblyNumber}`,
        lotId,
      });
      outputLotId = lotId;
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
router.post('/assemblies/:id/reverse', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    if (asm.status === 'reversed') return res.status(400).json({ error: 'Already reversed' });
    // Check no units have been sold
    const soldUnit = await req.db('mfg_assembly_units').where({ assembly_id: req.params.id, sold: 1 }).first();
    if (soldUnit) return res.status(400).json({ error: 'Cannot reverse: one or more units from this assembly have been sold' });

    await req.db.transaction(async (trx) => {
      // Remove the finished-product lot
      const units = await trx('mfg_assembly_units').where({ assembly_id: req.params.id });
      for (const unit of units) {
        if (unit.output_lot_id) {
          await trx('inv_stock_lots').where({ id: unit.output_lot_id }).delete();
        }
      }
      await recomputeItemStock(trx, asm.product_item_id);

      // Restore component stock by re-creating lots from the assembly_items traceability
      const items = await trx('mfg_assembly_items').where({ assembly_id: req.params.id });
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