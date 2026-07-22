const express = require('express');
const router = express.Router();

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
  id: r.id, bomId: r.bom_id, productItemId: r.product_item_id,
  quantityBuilt: Number(r.quantity_built), assemblyDate: r.assembly_date,
  notes: r.notes, createdBy: r.created_by, createdAt: r.created_at,
});
const mapAssemblyLine = (r) => r && ({
  id: r.id, assemblyId: r.assembly_id, componentItemId: r.component_item_id,
  quantityConsumed: Number(r.quantity_consumed),
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

// POST /api/:slug/manufacturing/boms
// Body: { name, productItemId, notes, lines: [{componentItemId, quantityPerUnit}] }
router.post('/boms', async (req, res) => {
  try {
    const { name, productItemId, notes, lines } = req.body;
    if (!name || !productItemId) return res.status(400).json({ error: 'name and productItemId are required' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'At least one component line is required' });

    const product = await req.db('inv_items').where({ id: productItemId }).first();
    if (!product) return res.status(400).json({ error: 'Product item not found' });

    const id = 'bom' + Date.now();
    await req.db('mfg_boms').insert({ id, name, product_item_id: productItemId, notes: notes || null });
    for (const line of lines) {
      if (!line.componentItemId || !line.quantityPerUnit) continue;
      await req.db('mfg_bom_lines').insert({
        id: 'boml' + Date.now() + Math.random().toString(36).slice(2, 6),
        bom_id: id,
        component_item_id: line.componentItemId,
        quantity_per_unit: line.quantityPerUnit,
      });
    }
    const saved = await req.db('mfg_boms').where({ id }).first();
    const savedLines = await req.db('mfg_bom_lines').where({ bom_id: id });
    req.io.to(req.company.slug).emit('mfg:bom_created', mapBom(saved));
    res.json({ ...mapBom(saved), lines: savedLines.map(mapBomLine) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/manufacturing/boms/:id — edit name/notes, optionally
// replace the entire line list (simplest safe way to "edit a recipe").
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
          id: 'boml' + Date.now() + Math.random().toString(36).slice(2, 6),
          bom_id: req.params.id,
          component_item_id: line.componentItemId,
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

// ── Assemblies ────────────────────────────────────────────────────────────────

router.get('/assemblies', async (req, res) => {
  try {
    const rows = await req.db('mfg_assemblies').orderBy('assembly_date', 'desc').orderBy('created_at', 'desc');
    res.json(rows.map(mapAssembly));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/assemblies/:id', async (req, res) => {
  try {
    const asm = await req.db('mfg_assemblies').where({ id: req.params.id }).first();
    if (!asm) return res.status(404).json({ error: 'Assembly not found' });
    const lines = await req.db('mfg_assembly_lines').where({ assembly_id: req.params.id });
    res.json({ ...mapAssembly(asm), lines: lines.map(mapAssemblyLine) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/manufacturing/boms/:id/check?quantity=N — dry-run stock
// check before actually building, so the UI can show "you're short 3 Bells"
// before the user commits to an assembly.
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
        componentName: item?.name || 'Unknown item',
        required, available,
        sufficient: available >= required,
      });
    }
    res.json({ quantity, canBuild: results.every(r => r.sufficient), lines: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/manufacturing/assemblies — execute a build.
// Body: { bomId, quantityBuilt, notes }
// Validates every component has enough stock BEFORE touching anything, then
// does the consume-and-create in one transaction: all components decrement,
// the product increments, or none of it happens.
router.post('/assemblies', async (req, res) => {
  try {
    const { bomId, quantityBuilt, notes } = req.body;
    if (!bomId || !quantityBuilt || Number(quantityBuilt) <= 0) {
      return res.status(400).json({ error: 'bomId and a positive quantityBuilt are required' });
    }
    const bom = await req.db('mfg_boms').where({ id: bomId }).first();
    if (!bom) return res.status(400).json({ error: 'BOM not found' });
    const lines = await req.db('mfg_bom_lines').where({ bom_id: bomId });
    if (!lines.length) return res.status(400).json({ error: 'This BOM has no component lines' });

    // Check stock sufficiency for every line before changing anything.
    const shortfalls = [];
    const requirements = [];
    for (const line of lines) {
      const item = await req.db('inv_items').where({ id: line.component_item_id }).first();
      const required = Number(line.quantity_per_unit) * Number(quantityBuilt);
      const available = Number(item?.stock || 0);
      requirements.push({ item, required });
      if (available < required) {
        shortfalls.push(`${item?.name || line.component_item_id}: need ${required}, only ${available} available`);
      }
    }
    if (shortfalls.length) {
      return res.status(400).json({ error: 'Not enough stock to build this: ' + shortfalls.join('; ') });
    }

    const assemblyId = 'asm' + Date.now();
    const updatedItemIds = [];

    await req.db.transaction(async (trx) => {
      await trx('mfg_assemblies').insert({
        id: assemblyId,
        bom_id: bomId,
        product_item_id: bom.product_item_id,
        quantity_built: quantityBuilt,
        notes: notes || null,
        created_by: req.user?.userId || null,
      });
      for (const { item, required } of requirements) {
        await trx('mfg_assembly_lines').insert({
          id: 'asml' + Date.now() + Math.random().toString(36).slice(2, 6),
          assembly_id: assemblyId,
          component_item_id: item.id,
          quantity_consumed: required,
        });
        await trx('inv_items').where({ id: item.id }).update({
          stock: Number(item.stock || 0) - required,
          updated_at: new Date(),
        });
        updatedItemIds.push(item.id);
      }
      const product = await trx('inv_items').where({ id: bom.product_item_id }).first();
      await trx('inv_items').where({ id: bom.product_item_id }).update({
        stock: Number(product.stock || 0) + Number(quantityBuilt),
        updated_at: new Date(),
      });
      updatedItemIds.push(bom.product_item_id);
    });

    // Broadcast updated stock for every item this assembly touched.
    for (const itemId of [...new Set(updatedItemIds)]) {
      const savedItem = await req.db('inv_items').where({ id: itemId }).first();
      req.io.to(req.company.slug).emit('inv:item_updated', {
        id: savedItem.id, stock: Number(savedItem.stock), name: savedItem.name,
      });
    }

    const savedAssembly = await req.db('mfg_assemblies').where({ id: assemblyId }).first();
    req.io.to(req.company.slug).emit('mfg:assembly_created', mapAssembly(savedAssembly));
    res.json(mapAssembly(savedAssembly));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;