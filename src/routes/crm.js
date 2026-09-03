const express = require('express');
const router = express.Router();

// ── Row mappers ────────────────────────────────────────────────────────────────
const mapLead = (r) => r && ({
  id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone,
  position: r.position, source: r.source, status: r.status,
  estimatedValue: r.estimated_value != null ? Number(r.estimated_value) : null,
  notes: r.notes, assignedTo: r.assigned_to,
  convertedToProspectId: r.converted_to_prospect_id, convertedAt: r.converted_at,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapProspect = (r) => r && ({
  id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone,
  position: r.position, source: r.source, status: r.status,
  estimatedValue: r.estimated_value != null ? Number(r.estimated_value) : null,
  notes: r.notes, assignedTo: r.assigned_to,
  originalLeadId: r.original_lead_id,
  convertedToCustomerId: r.converted_to_customer_id, convertedAt: r.converted_at,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapCustomer = (r) => r && ({
  id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone,
  position: r.position, source: r.source, status: r.status,
  lifetimeValue: Number(r.lifetime_value || 0),
  billingAddress: r.billing_address, shippingAddress: r.shipping_address,
  notes: r.notes, assignedTo: r.assigned_to,
  originalProspectId: r.original_prospect_id,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPO = (r) => r && ({
  id: r.id, poNumber: r.po_number, customerId: r.customer_id,
  status: r.status, orderDate: r.order_date, deliveryDate: r.delivery_date,
  totalValue: r.total_value != null ? Number(r.total_value) : null,
  paymentTerms: r.payment_terms,
  notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapPOItem = (r) => r && ({
  id: r.id, purchaseOrderId: r.purchase_order_id, itemId: r.item_id,
  bomId: r.bom_id, assemblyQuantity: r.assembly_quantity != null ? Number(r.assembly_quantity) : null,
  quantity: r.quantity != null ? Number(r.quantity) : null,
  quantityFulfilled: Number(r.quantity_fulfilled || 0),
  unitPrice: r.unit_price != null ? Number(r.unit_price) : null,
  lineTotal: r.line_total != null ? Number(r.line_total) : null,
});

// Helper: which table does an id prefix map to?
function tableForId(id) {
  if (!id) return null;
  if (id.startsWith('lead_')) return 'leads';
  if (id.startsWith('prospect_')) return 'prospects';
  if (id.startsWith('customer_')) return 'customers';
  return null;
}
function mapFnForTable(table) {
  return { leads: mapLead, prospects: mapProspect, customers: mapCustomer }[table];
}

// ── Leads ─────────────────────────────────────────────────────────────────────

router.get('/leads', async (req, res) => {
  try {
    let q = req.db('leads');
    if (req.query.status) q = q.where({ status: req.query.status });
    const rows = await q.orderBy('updated_at', 'desc');
    res.json(rows.map(mapLead));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const row = await req.db('leads').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Lead not found' });
    res.json(mapLead(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/leads', async (req, res) => {
  try {
    const { name, company, email, phone, position, source, assignedTo, status, estimatedValue, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'lead_' + Date.now();
    await req.db('leads').insert({
      id, name, company: company || null, email: email || null, phone: phone || null,
      position: position || null, source: source || null,
      assigned_to: assignedTo || null, status: status || 'New',
      estimated_value: estimatedValue != null ? estimatedValue : null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('leads').where({ id }).first();
    req.io.to(req.company.slug).emit('crm:lead_created', mapLead(saved));
    res.json(mapLead(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared conversion logic used by both the manual "Convert to Prospect"
// button and the automatic trigger when a lead's status is set to
// "Qualified" (see PATCH /leads/:id below). Returns the new prospect row,
// or null if this lead was already converted.
async function convertLeadToProspectInternal(db, io, companySlug, userId, lead) {
  if (lead.converted_to_prospect_id) return null;
  const prospectId = 'prospect_' + Date.now();
  await db('prospects').insert({
    id: prospectId, name: lead.name, company: lead.company,
    email: lead.email, phone: lead.phone, position: lead.position,
    source: lead.source, status: 'Contacted',
    estimated_value: lead.estimated_value, notes: lead.notes,
    assigned_to: lead.assigned_to, original_lead_id: lead.id,
    created_by: userId || null,
  });
  await db('leads').where({ id: lead.id }).update({
    converted_to_prospect_id: prospectId, converted_at: new Date(),
  });
  const saved = await db('prospects').where({ id: prospectId }).first();
  io.to(companySlug).emit('crm:prospect_created', mapProspect(saved));
  return saved;
}

router.patch('/leads/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.company !== undefined) updates.company = b.company;
    if (b.email !== undefined) updates.email = b.email;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.position !== undefined) updates.position = b.position;
    if (b.source !== undefined) updates.source = b.source;
    if (b.assignedTo !== undefined) updates.assigned_to = b.assignedTo;
    if (b.status !== undefined) updates.status = b.status;
    if (b.estimatedValue !== undefined) updates.estimated_value = b.estimatedValue;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('leads').where({ id: req.params.id }).update(updates);
    const saved = await req.db('leads').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Lead not found' });

    // Auto-conversion: setting a lead's status to "Qualified" moves it to
    // Prospects automatically, same as clicking the manual Convert button.
    // Only fires on the transition into Qualified (not e.g. re-saving an
    // already-Qualified lead) and only if it hasn't been converted already.
    let autoConvertedProspect = null;
    if (b.status !== undefined && String(b.status).toLowerCase() === 'qualified' && !saved.converted_to_prospect_id) {
      autoConvertedProspect = await convertLeadToProspectInternal(req.db, req.io, req.company.slug, req.user?.userId, saved);
    }

    req.io.to(req.company.slug).emit('crm:lead_updated', mapLead(saved));
    const response = mapLead(autoConvertedProspect ? await req.db('leads').where({ id: req.params.id }).first() : saved);
    res.json(autoConvertedProspect ? { ...response, autoConvertedToProspect: mapProspect(autoConvertedProspect) } : response);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    const lead = await req.db('leads').where({ id: req.params.id }).first();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    // A converted lead has a prospect row pointing back at it via
    // original_lead_id (FK_prospects_lead) — deleting the lead outright
    // fails on that FK. The prospect itself already carries its own copy of
    // the lead's data (name/company/etc. were copied over at conversion
    // time), so clearing the back-reference is safe: it just means "this
    // prospect's original lead record no longer exists", not a data loss.
    if (lead.converted_to_prospect_id) {
      await req.db('prospects').where({ id: lead.converted_to_prospect_id }).update({ original_lead_id: null });
    }
    await req.db('leads').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('crm:lead_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/leads/:id/convert-to-prospect
router.post('/leads/:id/convert-to-prospect', async (req, res) => {
  try {
    const lead = await req.db('leads').where({ id: req.params.id }).first();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.converted_to_prospect_id) {
      return res.status(400).json({ error: 'This lead has already been converted to a prospect' });
    }
    const saved = await convertLeadToProspectInternal(req.db, req.io, req.company.slug, req.user?.userId, lead);
    res.json(mapProspect(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Prospects ─────────────────────────────────────────────────────────────────

router.get('/prospects', async (req, res) => {
  try {
    let q = req.db('prospects');
    if (req.query.status) q = q.where({ status: req.query.status });
    const rows = await q.orderBy('updated_at', 'desc');
    res.json(rows.map(mapProspect));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/prospects — direct creation, for when a prospect
// starts here rather than arriving via lead conversion (the "+ Add
// Prospect" button on the Prospects page). This route was missing entirely,
// which is why calling it hit Express's default 404 HTML error page instead
// of a JSON response — surfacing as "Unexpected token '<'" in the browser
// when the frontend tried to JSON.parse() that HTML.
router.post('/prospects', async (req, res) => {
  try {
    const { name, company, email, phone, position, source, assignedTo, status, estimatedValue, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'prospect_' + Date.now();
    await req.db('prospects').insert({
      id, name, company: company || null, email: email || null, phone: phone || null,
      position: position || null, source: source || null,
      assigned_to: assignedTo || null, status: status || 'Contacted',
      estimated_value: estimatedValue != null ? estimatedValue : null,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('prospects').where({ id }).first();
    req.io.to(req.company.slug).emit('crm:prospect_created', mapProspect(saved));
    res.json(mapProspect(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/prospects/:id', async (req, res) => {
  try {
    const row = await req.db('prospects').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Prospect not found' });
    res.json(mapProspect(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared conversion logic used by both the manual "Convert to Customer"
// button and the automatic trigger when a prospect's status is set to "Won"
// (see PATCH /prospects/:id below).
async function convertProspectToCustomerInternal(db, io, companySlug, userId, prospect) {
  if (prospect.converted_to_customer_id) return null;
  const customerId = 'customer_' + Date.now();
  await db('customers').insert({
    id: customerId, name: prospect.name, company: prospect.company,
    email: prospect.email, phone: prospect.phone, position: prospect.position,
    source: prospect.source, status: 'Active',
    notes: prospect.notes, assigned_to: prospect.assigned_to,
    original_prospect_id: prospect.id,
    created_by: userId || null,
  });
  await db('prospects').where({ id: prospect.id }).update({
    converted_to_customer_id: customerId, converted_at: new Date(),
  });
  const saved = await db('customers').where({ id: customerId }).first();
  io.to(companySlug).emit('crm:customer_created', mapCustomer(saved));
  return saved;
}

router.patch('/prospects/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.company !== undefined) updates.company = b.company;
    if (b.email !== undefined) updates.email = b.email;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.position !== undefined) updates.position = b.position;
    if (b.source !== undefined) updates.source = b.source;
    if (b.assignedTo !== undefined) updates.assigned_to = b.assignedTo;
    if (b.status !== undefined) updates.status = b.status;
    if (b.estimatedValue !== undefined) updates.estimated_value = b.estimatedValue;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('prospects').where({ id: req.params.id }).update(updates);
    const saved = await req.db('prospects').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Prospect not found' });

    // Auto-conversion: setting a prospect's status to "Won" moves it to
    // Customers automatically, same as clicking the manual Convert button.
    let autoConvertedCustomer = null;
    if (b.status !== undefined && String(b.status).toLowerCase() === 'won' && !saved.converted_to_customer_id) {
      autoConvertedCustomer = await convertProspectToCustomerInternal(req.db, req.io, req.company.slug, req.user?.userId, saved);
    }

    req.io.to(req.company.slug).emit('crm:prospect_updated', mapProspect(saved));
    const response = mapProspect(autoConvertedCustomer ? await req.db('prospects').where({ id: req.params.id }).first() : saved);
    res.json(autoConvertedCustomer ? { ...response, autoConvertedToCustomer: mapCustomer(autoConvertedCustomer) } : response);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/prospects/:id', async (req, res) => {
  try {
    const prospect = await req.db('prospects').where({ id: req.params.id }).first();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
    // Same situation as leads: a converted prospect has a customer pointing
    // back at it via original_prospect_id (FK_customers_prospect). Clear
    // that back-reference before deleting — the customer already has its
    // own copy of the data, so nothing is lost.
    if (prospect.converted_to_customer_id) {
      await req.db('customers').where({ id: prospect.converted_to_customer_id }).update({ original_prospect_id: null });
    }
    await req.db('prospects').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('crm:prospect_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/prospects/:id/convert-to-customer
router.post('/prospects/:id/convert-to-customer', async (req, res) => {
  try {
    const prospect = await req.db('prospects').where({ id: req.params.id }).first();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
    if (prospect.converted_to_customer_id) {
      return res.status(400).json({ error: 'This prospect has already been converted to a customer' });
    }
    const saved = await convertProspectToCustomerInternal(req.db, req.io, req.company.slug, req.user?.userId, prospect);
    res.json(mapCustomer(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customers ─────────────────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
  try {
    let q = req.db('customers');
    if (req.query.status) q = q.where({ status: req.query.status });
    const rows = await q.orderBy('updated_at', 'desc');
    res.json(rows.map(mapCustomer));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/crm/customers — direct creation, for when a customer
// starts here rather than arriving via prospect conversion (the "+ Add
// Customer" button). Same missing-route bug as prospects: calling this
// endpoint previously hit a 404 HTML page instead of JSON.
router.post('/customers', async (req, res) => {
  try {
    const { name, company, email, phone, position, source, assignedTo, status, billingAddress, shippingAddress, lifetimeValue, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = 'customer_' + Date.now();
    await req.db('customers').insert({
      id, name, company: company || null, email: email || null, phone: phone || null,
      position: position || null, source: source || null,
      assigned_to: assignedTo || null, status: status || 'Active',
      billing_address: billingAddress || null, shipping_address: shippingAddress || null,
      lifetime_value: lifetimeValue != null ? lifetimeValue : 0,
      notes: notes || null, created_by: req.user?.userId || null,
    });
    const saved = await req.db('customers').where({ id }).first();
    req.io.to(req.company.slug).emit('crm:customer_created', mapCustomer(saved));
    res.json(mapCustomer(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/customers/:id', async (req, res) => {
  try {
    const row = await req.db('customers').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Customer not found' });
    res.json(mapCustomer(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/customers/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.name !== undefined) updates.name = b.name;
    if (b.company !== undefined) updates.company = b.company;
    if (b.email !== undefined) updates.email = b.email;
    if (b.phone !== undefined) updates.phone = b.phone;
    if (b.position !== undefined) updates.position = b.position;
    if (b.source !== undefined) updates.source = b.source;
    if (b.assignedTo !== undefined) updates.assigned_to = b.assignedTo;
    if (b.status !== undefined) updates.status = b.status;
    if (b.billingAddress !== undefined) updates.billing_address = b.billingAddress;
    if (b.shippingAddress !== undefined) updates.shipping_address = b.shippingAddress;
    if (b.lifetimeValue !== undefined) updates.lifetime_value = b.lifetimeValue;
    if (b.notes !== undefined) updates.notes = b.notes;
    await req.db('customers').where({ id: req.params.id }).update(updates);
    const saved = await req.db('customers').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Customer not found' });
    req.io.to(req.company.slug).emit('crm:customer_updated', mapCustomer(saved));
    res.json(mapCustomer(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/customers/:id', async (req, res) => {
  try {
    const hasPOs = await req.db('customer_purchase_orders').where({ customer_id: req.params.id }).first();
    if (hasPOs) return res.status(400).json({ error: 'This customer has purchase orders and cannot be deleted.' });
    // sales.customer_id also references customers (FK_sales_customer) and
    // wasn't being checked here — a customer with sales but no POs would
    // still hit a raw FK failure instead of this clear message.
    const hasSales = await req.db('sales').where({ customer_id: req.params.id }).first();
    if (hasSales) return res.status(400).json({ error: 'This customer has sales records and cannot be deleted.' });
    await req.db('customers').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('crm:customer_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer Purchase Orders ───────────────────────────────────────────────────

router.get('/customer-purchase-orders', async (req, res) => {
  try {
    let q = req.db('customer_purchase_orders');
    if (req.query.customerId) q = q.where({ customer_id: req.query.customerId });
    if (req.query.status) q = q.where({ status: req.query.status });
    const rows = await q.orderBy('order_date', 'desc');
    const enriched = await Promise.all(rows.map(async (po) => {
      const items = await req.db('customer_purchase_order_items').where({ purchase_order_id: po.id });
      const customer = await req.db('customers').where({ id: po.customer_id }).first();
      const itemsWithBomName = await Promise.all(items.map(async (i) => {
        if (i.bom_id) {
          const bom = await req.db('mfg_boms').where({ id: i.bom_id }).first();
          return { ...mapPOItem(i), bomName: bom?.name || null };
        }
        return mapPOItem(i);
      }));
      return {
        ...mapPO(po),
        customerName: customer?.name || null,
        customerEmail: customer?.email || null,
        items: itemsWithBomName,
        totalQuantity: itemsWithBomName.reduce((s, i) => s + Number(i.assemblyQuantity || i.quantity || 0), 0),
      };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/customer-purchase-orders/:id', async (req, res) => {
  try {
    const po = await req.db('customer_purchase_orders').where({ id: req.params.id }).first();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const items = await req.db('customer_purchase_order_items').where({ purchase_order_id: po.id });
    res.json({ ...mapPO(po), items: items.map(mapPOItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/customer-purchase-orders', async (req, res) => {
  try {
    const { poNumber, customerId, orderDate, deliveryDate, paymentTerms, notes, items } = req.body;
    if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one BOM line is required' });
    const customer = await req.db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(400).json({ error: 'Customer not found' });

    // Every line must reference a BOM going forward — building a customer PO
    // always means "manufacture N units of this assembly", not ordering raw
    // inventory items directly.
    const shortfalls = [];
    const preparedLines = [];
    for (const line of items) {
      if (!line.bomId) return res.status(400).json({ error: 'Each PO line must specify a BOM' });
      const qty = Number(line.assemblyQuantity || 0);
      if (!qty || qty <= 0) return res.status(400).json({ error: 'Each PO line needs a positive assembly quantity' });

      const bom = await req.db('mfg_boms').where({ id: line.bomId }).first();
      if (!bom) return res.status(400).json({ error: `BOM ${line.bomId} not found` });

      // If the finished product's own stock already covers this line, the
      // order can be fulfilled straight from existing inventory — skip the
      // component-level check entirely rather than demanding raw-component
      // stock for units that don't need to be built. Only fall back to the
      // BOM/component check when finished-goods stock can't cover it alone.
      const product = await req.db('inv_items').where({ id: bom.product_item_id }).first();
      const finishedStock = Number(product?.stock || 0);
      if (finishedStock < qty) {
        const bomLines = await req.db('mfg_bom_lines').where({ bom_id: line.bomId });
        if (!bomLines.length) return res.status(400).json({ error: `BOM "${bom.name}" has no components defined` });

        for (const bl of bomLines) {
          const component = await req.db('inv_items').where({ id: bl.component_item_id }).first();
          const required = Number(bl.quantity_per_unit) * qty;
          const available = Number(component?.stock || 0);
          if (available < required) {
            shortfalls.push(`${component?.name || bl.component_item_id}: need ${required} for "${bom.name}" x${qty}, have ${available}`);
          }
        }
      }
      preparedLines.push({ bom, qty, unitPrice: Number(line.unitPrice || 0) });
    }
    if (shortfalls.length) {
      return res.status(400).json({ error: 'Not enough component stock to fulfil this PO: ' + shortfalls.join('; ') });
    }

    const id = 'cpo_' + Date.now();
    await req.db('customer_purchase_orders').insert({
      id, po_number: poNumber, customer_id: customerId,
      order_date: orderDate || new Date(), delivery_date: deliveryDate || null,
      payment_terms: paymentTerms || null,
      notes: notes || null, created_by: req.user?.userId || null,
    });

    let totalValue = 0;
    for (const { bom, qty, unitPrice } of preparedLines) {
      const lineTotal = qty * unitPrice;
      totalValue += lineTotal;
      await req.db('customer_purchase_order_items').insert({
        id: 'cpoi_' + Date.now() + Math.random().toString(36).slice(2, 6),
        purchase_order_id: id,
        bom_id: bom.id,
        assembly_quantity: qty,
        unit_price: unitPrice || null,
        line_total: lineTotal || null,
      });
    }
    await req.db('customer_purchase_orders').where({ id }).update({ total_value: totalValue });

    const saved = await req.db('customer_purchase_orders').where({ id }).first();
    const savedItems = await req.db('customer_purchase_order_items').where({ purchase_order_id: id });
    req.io.to(req.company.slug).emit('crm:customer_po_created', mapPO(saved));
    res.json({ ...mapPO(saved), items: savedItems.map(mapPOItem) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/crm/customer-purchase-orders/:id/history — order/sales/delivery
// history for the expandable row in the Orders page.
router.get('/customer-purchase-orders/:id/history', async (req, res) => {
  try {
    const po = await req.db('customer_purchase_orders').where({ id: req.params.id }).first();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const sales = await req.db('sales').where({ customer_po_id: req.params.id }).orderBy('sale_date', 'desc');
    const saleIds = sales.map(s => s.id);
    const deliveries = saleIds.length
      ? await req.db('deliveries').whereIn('sale_id', saleIds).orderBy('created_at', 'desc')
      : [];
    res.json({
      sales: sales.map(s => ({
        id: s.id, saleNumber: s.sale_number, saleDate: s.sale_date, total: Number(s.total || 0),
      })),
      deliveries: deliveries.map(d => ({
        id: d.id, deliveryNumber: d.delivery_number, scheduledDate: d.scheduled_date,
        delivered: !!d.delivered, deliveredDate: d.delivered_date,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/customer-purchase-orders/:id', async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date() };
    if (b.poNumber !== undefined) updates.po_number = b.poNumber;
    if (b.status !== undefined) updates.status = b.status;
    if (b.deliveryDate !== undefined) updates.delivery_date = b.deliveryDate;
    if (b.paymentTerms !== undefined) updates.payment_terms = b.paymentTerms;
    if (b.notes !== undefined) updates.notes = b.notes;
    if (b.totalValue !== undefined) updates.total_value = b.totalValue;
    await req.db('customer_purchase_orders').where({ id: req.params.id }).update(updates);
    const saved = await req.db('customer_purchase_orders').where({ id: req.params.id }).first();
    if (!saved) return res.status(404).json({ error: 'Purchase order not found' });
    req.io.to(req.company.slug).emit('crm:customer_po_updated', mapPO(saved));
    res.json(mapPO(saved));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/customer-purchase-orders/:id', async (req, res) => {
  try {
    await req.db('customer_purchase_order_items').where({ purchase_order_id: req.params.id }).delete();
    await req.db('customer_purchase_orders').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('crm:customer_po_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;