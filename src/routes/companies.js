const express = require('express');
const coreDb = require('../db/core');
const { invalidateCompanyCache } = require('../db/tenantConnections');

const router = express.Router();

// GET /api/companies/by-slug/:slug — PUBLIC branding lookup used by the
// tenant frontend before login (splash screen, login card, hexagon colors).
// Only returns safe, non-sensitive branding fields — never db_name, status
// details beyond active/suspended, or anything else from the row.
router.get('/by-slug/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const company = await coreDb('companies').where({ slug }).first();
    if (!company) return res.status(404).json({ error: 'Unknown company' });
    if (company.status !== 'active') {
      return res.status(403).json({ error: `Company is ${company.status}` });
    }
    res.json({
      slug: company.slug,
      name: company.name,
      logo: company.logo_url || null,
      primaryColor: company.primary_color || null,
      secondaryColor: company.secondary_color || null,
      accentColor: company.accent_color || null,
      modules: JSON.parse(company.enabled_modules || '[]'),
      customModules: company.custom_modules ? JSON.parse(company.custom_modules) : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/companies — masteradmin's company list
router.get('/', async (req, res) => {
  try {
    const rows = await coreDb('companies').orderBy('created_at', 'desc');
    res.json(rows.map(r => ({ ...r, enabled_modules: JSON.parse(r.enabled_modules || '[]') })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/companies — create a new tenant record.
// NOTE: this only inserts the OGCore row. Actual database creation +
// schema provisioning (CREATE DATABASE + running 01_core_tenant.sql etc.)
// is a separate step — see the provisioning script we build next; for now
// db_name must be created/provisioned manually to match what you pass here.
router.post('/', async (req, res) => {
  try {
    const { name, slug, db_name, logo_url, primary_color, secondary_color, accent_color, enabled_modules } = req.body;
    if (!name || !slug || !db_name) {
      return res.status(400).json({ error: 'name, slug, and db_name are required' });
    }
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const existing = await coreDb('companies').where({ slug: cleanSlug }).first();
    if (existing) return res.status(400).json({ error: `Slug "${cleanSlug}" is already in use` });

    const [row] = await coreDb('companies')
      .insert({
        name,
        slug: cleanSlug,
        db_name,
        logo_url: logo_url || null,
        primary_color: primary_color || '#C0392B',
        secondary_color: secondary_color || null,
        accent_color: accent_color || null,
        enabled_modules: JSON.stringify(enabled_modules || []),
        status: 'active',
      })
      .returning('*');

    res.json({ ...row, enabled_modules: JSON.parse(row.enabled_modules) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/companies/:id — edit branding, modules, or status
router.patch('/:id', async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date() };
    if (updates.enabled_modules) updates.enabled_modules = JSON.stringify(updates.enabled_modules);
    if (updates.custom_modules) updates.custom_modules = JSON.stringify(updates.custom_modules);

    const existing = await coreDb('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Company not found' });

    await coreDb('companies').where({ id: req.params.id }).update(updates);
    invalidateCompanyCache(existing.slug); // so branding/module changes take effect immediately, not after 30s TTL

    const row = await coreDb('companies').where({ id: req.params.id }).first();
    res.json({ ...row, enabled_modules: JSON.parse(row.enabled_modules) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await coreDb('companies').where({ id: req.params.id }).first();
    if (existing) invalidateCompanyCache(existing.slug);
    await coreDb('companies').where({ id: req.params.id }).delete();
    // NOTE: this deliberately does NOT drop the tenant's physical database —
    // that's a destructive action requiring separate deliberate confirmation,
    // not something a routine delete-row call should ever trigger.
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
