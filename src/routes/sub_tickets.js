const express = require('express');
const { nextCounter, formatCode } = require('../utils/counters');
const router = express.Router();

const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
const num = (v) => (v == null ? null : Number(v));

// Frontend expects camelCase: id, ticketId, raisedById, raisedByName, name, subject,
//   amount, currency, billingCycle, category, purpose, link, status, paidAt, updatedAt, createdAt
const mapTicket = (r) => {
  const ex = r.extra_json ? JSON.parse(r.extra_json) : {};
  return {
    id: r.id,
    ticketId: r.ticket_id,
    raisedById: r.raised_by_id,
    raisedByName: r.raised_by_name,
    // 'name' is the subscription/service name; stored in extra_json or subject
    name: ex.name || r.subject || null,
    subject: r.subject,
    description: r.description,
    amount: num(ex.amount),
    currency: ex.currency || null,
    billingCycle: ex.billingCycle || null,
    category: ex.category || null,
    purpose: ex.purpose || null,
    link: ex.link || null,
    status: r.status,
    paidAt: dTime(ex.paidAt || null),
    updatedAt: dTime(r.updated_at),
    createdAt: dTime(r.created_at),
  };
};

// GET /api/:slug/sub-tickets?userId=...&role=...
router.get('/', async (req, res) => {
  try {
    const { userId, role } = req.query;
    let q = req.db('sub_tickets').orderBy('created_at', 'desc');
    const viewAll = ['superadmin', 'manager', 'accounts_manager'].includes(role);
    if (!viewAll && userId) q = q.where('raised_by_id', userId);
    res.json((await q).map(mapTicket));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sub-tickets
// Frontend sends: { name, amount, currency, billingCycle, category, purpose, link, raisedById, raisedByName }
router.post('/', async (req, res) => {
  try {
    const { raisedById, raisedByName, name, amount, currency, billingCycle, category, purpose, link, ...rest } = req.body;
    const counter = await nextCounter(req.db, 'sub_ticket_counter');
    const ticketId = formatCode('REQ', counter, 3);
    const id = 'req' + Date.now();
    // Store accounting-specific fields in extra_json; keep raised_by in real columns
    const extra = { name, amount, currency, billingCycle, category, purpose, link, ...rest };
    await req.db('sub_tickets').insert({
      id, ticket_id: ticketId,
      raised_by_id: raisedById || null,
      raised_by_name: raisedByName || null,
      subject: name || null,        // store name also in subject as searchable text
      description: purpose || null,
      status: 'pending',
      extra_json: JSON.stringify(extra),
    });
    res.json(mapTicket(await req.db('sub_tickets').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/sub-tickets/:id
router.patch('/:id', async (req, res) => {
  try {
    const current = await req.db('sub_tickets').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Not found' });
    const { raisedById, raisedByName, status, name, ...rest } = req.body;
    const currentExtra = current.extra_json ? JSON.parse(current.extra_json) : {};
    const newExtra = { ...currentExtra, ...rest };
    if (name) { newExtra.name = name; }
    const upd = { extra_json: JSON.stringify(newExtra), updated_at: new Date() };
    if (status !== undefined) upd.status = status;
    if (name !== undefined) upd.subject = name;
    if (raisedById !== undefined) upd.raised_by_id = raisedById;
    if (raisedByName !== undefined) upd.raised_by_name = raisedByName;
    await req.db('sub_tickets').where({ id: req.params.id }).update(upd);
    res.json(mapTicket(await req.db('sub_tickets').where({ id: req.params.id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/sub-tickets/:id
router.delete('/:id', async (req, res) => {
  try {
    await req.db('sub_tickets').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;