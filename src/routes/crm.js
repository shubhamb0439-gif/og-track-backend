const express = require('express');
const router = express.Router();

// ── Row mapper ────────────────────────────────────────────────────────────────
// Frontend reads: id, name, companyName, email, phone, source, assignedTo,
//   stage, kanbanStatus, estimatedValue, lifetimeValue, customerStatus,
//   notes, lostReason, createdAt, updatedAt
const mapContact = (r) => r && ({
  id: r.id,
  name: r.name,
  companyName: r.company_name,
  email: r.email,
  phone: r.phone,
  source: r.source,
  assignedTo: r.assigned_to,
  stage: r.stage,
  kanbanStatus: r.kanban_status,
  estimatedValue: r.estimated_value != null ? Number(r.estimated_value) : null,
  lifetimeValue: Number(r.lifetime_value || 0),
  customerStatus: r.customer_status,
  notes: r.notes,
  lostReason: r.lost_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapSale = (r) => r && ({
  id: r.id,
  contactId: r.contact_id,
  amount: Number(r.amount),
  saleDate: r.sale_date,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

// GET /api/:slug/crm/contacts?stage=lead|prospect|customer|lost
router.get('/contacts', async (req, res) => {
  try {
    let q = req.db('crm_contacts');
    if (req.query.stage) q = q.where({ stage: req.query.stage });
    const rows = await q.orderBy('updated_at', 'desc');
    res.json(rows.map(mapContact));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/crm/contacts/:id
router.get('/contacts/:id', async (req, res) => {
  try {
    const row = await req.db('crm_contacts').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Contact not found' });
    res.json(mapContact(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/contacts — create a new lead
router.post('/contacts', async (req, res) => {
  try {
    const { name, companyName, email, phone, source, assignedTo, estimatedValue, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'lead' + Date.now();
    const row = {
      id, name,
      company_name: companyName || null,
      email: email || null,
      phone: phone || null,
      source: source || null,
      assigned_to: assignedTo || null,
      stage: 'lead',
      kanban_status: 'new',
      estimated_value: estimatedValue != null ? estimatedValue : null,
      notes: notes || null,
    };
    await req.db('crm_contacts').insert(row);
    const saved = await req.db('crm_contacts').where({ id }).first();
    req.io.to(req.company.slug).emit('crm:contact_created', mapContact(saved));
    res.json(mapContact(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/crm/contacts/:id — general field edits (name, notes, estimatedValue, etc.)
router.patch('/contacts/:id', async (req, res) => {
  try {
    const existing = await req.db('crm_contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.companyName !== undefined) updates.company_name = b.companyName;
    if (b.email !== undefined) updates.email = b.email;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.source !== undefined) updates.source = b.source;
    if (b.assignedTo !== undefined) updates.assigned_to = b.assignedTo;
    if (b.estimatedValue !== undefined) updates.estimated_value = b.estimatedValue;
    if (b.customerStatus !== undefined) updates.customer_status = b.customerStatus;
    if (b.notes !== undefined) updates.notes = b.notes;

    await req.db('crm_contacts').where({ id: req.params.id }).update(updates);
    const saved = await req.db('crm_contacts').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('crm:contact_updated', mapContact(saved));
    res.json(mapContact(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/crm/contacts/:id/stage — move through the funnel
// Body: { stage: 'lead'|'prospect'|'customer'|'lost', kanbanStatus?, lostReason? }
router.patch('/contacts/:id/stage', async (req, res) => {
  try {
    const { stage, kanbanStatus, lostReason } = req.body;
    if (!['lead', 'prospect', 'customer', 'lost'].includes(stage)) {
      return res.status(400).json({ error: "stage must be 'lead', 'prospect', 'customer', or 'lost'" });
    }
    const existing = await req.db('crm_contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const updates = { stage, updated_at: new Date() };
    if (kanbanStatus) updates.kanban_status = kanbanStatus;
    if (stage === 'lost') updates.lost_reason = lostReason || null;
    // Moving into 'customer' for the first time — default a health status
    // if one hasn't been set yet.
    if (stage === 'customer' && !existing.customer_status) updates.customer_status = 'active';

    await req.db('crm_contacts').where({ id: req.params.id }).update(updates);
    const saved = await req.db('crm_contacts').where({ id: req.params.id }).first();
    req.io.to(req.company.slug).emit('crm:contact_updated', mapContact(saved));
    res.json(mapContact(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/crm/contacts/:id
router.delete('/contacts/:id', async (req, res) => {
  try {
    await req.db('crm_sales').where({ contact_id: req.params.id }).delete();
    await req.db('crm_contacts').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('crm:contact_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales ─────────────────────────────────────────────────────────────────────

// GET /api/:slug/crm/contacts/:id/sales — a customer's sale history
router.get('/contacts/:id/sales', async (req, res) => {
  try {
    const rows = await req.db('crm_sales').where({ contact_id: req.params.id }).orderBy('sale_date', 'desc');
    res.json(rows.map(mapSale));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/contacts/:id/sales — record a completed sale.
// This is the ONLY way lifetime_value changes — it's recomputed as the sum
// of this contact's sales rows, never taken directly from client input, so
// the number always matches the audit trail underneath it. Also promotes
// the contact to stage='customer' if it wasn't already (matches the Cajo
// behavior where recording a sale is what makes someone a Customer).
router.post('/contacts/:id/sales', async (req, res) => {
  try {
    const { amount, saleDate, notes } = req.body;
    if (amount == null || isNaN(Number(amount))) {
      return res.status(400).json({ error: 'amount is required and must be a number' });
    }
    const contact = await req.db('crm_contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const saleId = 'sale' + Date.now();
    await req.db('crm_sales').insert({
      id: saleId,
      contact_id: req.params.id,
      amount,
      sale_date: saleDate || new Date(),
      notes: notes || null,
      created_by: req.user?.userId || null,
    });

    const { sum } = await req.db('crm_sales').where({ contact_id: req.params.id }).sum('amount as sum').first();
    const contactUpdates = {
      lifetime_value: sum || 0,
      updated_at: new Date(),
    };
    if (contact.stage !== 'customer') {
      contactUpdates.stage = 'customer';
      contactUpdates.customer_status = contact.customer_status || 'active';
    }
    await req.db('crm_contacts').where({ id: req.params.id }).update(contactUpdates);

    const savedContact = await req.db('crm_contacts').where({ id: req.params.id }).first();
    const savedSale = await req.db('crm_sales').where({ id: saleId }).first();
    req.io.to(req.company.slug).emit('crm:contact_updated', mapContact(savedContact));
    res.json({ sale: mapSale(savedSale), contact: mapContact(savedContact) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;