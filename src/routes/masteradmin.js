const express = require('express');
const coreDb = require('../db/core');
const { hashPassword, verifyPassword, issueToken } = require('../utils/auth');
const { provisionTenant, provisionModulesForExistingCompany } = require('../utils/provisioning');

const multer = require('multer');
const path = require('path');
const { uploadBuffer } = require('../utils/blobStorage');

// ── Logo uploads for company branding ─────────────────────
// Stored in Azure Blob Storage (not local disk — App Service disk is ephemeral).
// multer.memoryStorage() just buffers the file in RAM briefly; nothing is
// written to disk before it's streamed up to the blob container.
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.mimetype)) {
      return cb(new Error('Logo must be a PNG, JPEG, or SVG image'));
    }
    cb(null, true);
  },
});
const router = express.Router();

// ── Middleware: verify masteradmin JWT ───────────────────────────────────────
function requireMasterAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'masteradmin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── POST /api/masteradmin/login ──────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const admin = await coreDb('platform_admins').where({ email: email.toLowerCase() }).first();
    if (!admin) return res.status(401).json({ error: 'Invalid email or password' });
    if (admin.status !== 'active') return res.status(403).json({ error: 'Account is not active' });
    const ok = await verifyPassword(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { adminId: admin.id, name: admin.name, email: admin.email, role: 'masteradmin' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/masteradmin/companies ───────────────────────────────────────────
router.get('/companies', requireMasterAdmin, async (req, res) => {
  try {
    const rows = await coreDb('companies').orderBy('created_at', 'desc');
    // attach latest provisioning status
    const logs = await coreDb('provisioning_log').orderBy('created_at', 'desc');
    const logMap = {};
    logs.forEach(l => { if (!logMap[l.company_id]) logMap[l.company_id] = l; });
    res.json(rows.map(r => ({
      ...r,
      enabled_modules: JSON.parse(r.enabled_modules || '[]'),
      lastProvisionStep: logMap[r.id]?.step || null,
      lastProvisionStatus: logMap[r.id]?.status || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/masteradmin/companies — create + auto-provision ────────────────
router.post('/companies', requireMasterAdmin, async (req, res) => {
  try {
    const { name, slug, db_name, logo_url, primary_color, secondary_color,
            accent_color, enabled_modules, admin_name, admin_email } = req.body;
    if (!name || !slug || !db_name) {
      return res.status(400).json({ error: 'name, slug, and db_name are required' });
    }
    if (!admin_email) {
      return res.status(400).json({ error: 'admin_email is required — this becomes the company\'s first superadmin login, since a brand-new tenant has no one to approve the first registration otherwise.' });
    }
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const existing = await coreDb('companies').where({ slug: cleanSlug }).first();
    if (existing) return res.status(400).json({ error: `Slug "${cleanSlug}" already in use` });

    const modules = enabled_modules || [
      'dashboard','projects','sprints','bugs','sub_tickets',
      'attendance','history','messages','admin','roles'
    ];

    // Insert OGCore record first so we have the company id for the log
    await coreDb('companies').insert({
      name, slug: cleanSlug, db_name,
      logo_url: logo_url || null,
      primary_color: primary_color || '#C0392B',
      secondary_color: secondary_color || null,
      accent_color: accent_color || null,
      enabled_modules: JSON.stringify(modules),
      status: 'active',
    });
    const company = await coreDb('companies').where({ slug: cleanSlug }).first();

    // Kick off provisioning (async — returns immediately, logs progress).
    // The seeded superadmin's temp password shows up in the provisioning log
    // (the existing "Log" button on each company row), not in this response,
    // since provisioning finishes after this request has already returned.
    provisionTenant(company, modules, { adminName: admin_name || 'Admin', adminEmail: admin_email }).catch(err => {
      console.error('[provisioning] background error for', cleanSlug, err.message);
    });

    res.json({
      ...company,
      enabled_modules: modules,
      provisioning: 'started',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/masteradmin/companies/:id ─────────────────────────────────────
router.patch('/companies/:id', requireMasterAdmin, async (req, res) => {
  try {
    const { invalidateCompanyCache } = require('../db/tenantConnections');
    const updates = { ...req.body, updated_at: new Date() };
    if (updates.enabled_modules) updates.enabled_modules = JSON.stringify(updates.enabled_modules);
    delete updates.lastProvisionStep; delete updates.lastProvisionStatus;

    const existing = await coreDb('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Company not found' });
    await coreDb('companies').where({ id: req.params.id }).update(updates);
    invalidateCompanyCache(existing.slug);

    const row = await coreDb('companies').where({ id: req.params.id }).first();
    const newModules = JSON.parse(row.enabled_modules || '[]');

    // If modules changed, make sure the newly-checked ones actually have their
    // tables in THIS company's own database — checking the box alone only
    // updates the OGCore flag, it doesn't touch the tenant DB by itself.
    // Fire-and-forget, same pattern as initial creation; safe to re-run since
    // it skips objects that already exist.
    if (req.body.enabled_modules) {
      provisionModulesForExistingCompany(row, newModules).catch(err => {
        console.error('[provisioning] module re-provision failed for', row.slug, err.message);
      });
    }

    res.json({ ...row, enabled_modules: newModules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/masteradmin/companies/:id/provision-modules ───
// Manual trigger to (re-)run schema scripts for whatever modules a company
// currently has enabled. Useful right after adding this new endpoint itself
// (for companies whose modules were already toggled before this existed),
// or any time you want to double-check a company's tables are up to date.
router.post('/companies/:id/provision-modules', requireMasterAdmin, async (req, res) => {
  try {
    const company = await coreDb('companies').where({ id: req.params.id }).first();
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const modules = JSON.parse(company.enabled_modules || '[]');
    await provisionModulesForExistingCompany(company, modules);
    res.json({ success: true, message: 'Schema scripts re-checked — see the Log for details.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/masteradmin/companies/:id ────────────────────────────────────
router.delete('/companies/:id', requireMasterAdmin, async (req, res) => {
  try {
    const { invalidateCompanyCache } = require('../db/tenantConnections');
    const existing = await coreDb('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    invalidateCompanyCache(existing.slug);
    await coreDb('provisioning_log').where({ company_id: req.params.id }).delete();
    await coreDb('companies').where({ id: req.params.id }).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/masteradmin/provisioning-log/:companyId ─────────────────────────
router.get('/provisioning-log/:companyId', requireMasterAdmin, async (req, res) => {
  try {
    const rows = await coreDb('provisioning_log')
      .where({ company_id: req.params.companyId })
      .orderBy('created_at', 'asc');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/masteradmin/upload-logo — upload a company logo PNG/JPEG/SVG ───
// Used from the New/Edit Company modal. Works even before a company row
// exists (create flow), so it can't depend on tenant resolution. Returns
// a URL to store in companies.logo_url.
router.post('/upload-logo', requireMasterAdmin, brandingUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname) || '.png';
    const blobName = 'logo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    const url = await uploadBuffer(req.file.buffer, blobName, req.file.mimetype);
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/masteradmin/pending-users — pending signups across EVERY company ───
// Each company has its own database (data isolation), so a signup for Cajo
// never touches OGTrack's own users table. This is the one place that's
// allowed to reach across all of them, since it authenticates as a
// platform-wide admin rather than a single company's user.
router.get('/pending-users', requireMasterAdmin, async (req, res) => {
  try {
    const { getTenantDbByName } = require('../db/tenantConnections');
    const companies = await coreDb('companies').where({ status: 'active' });
    const results = [];
    for (const company of companies) {
      try {
        const db = getTenantDbByName(company.db_name);
        const pending = await db('users').where({ status: 'pending' }).select('*');
        pending.forEach((u) => {
          const { password_hash, ...safe } = u;
          results.push({ ...safe, company_name: company.name, company_slug: company.slug });
        });
      } catch (e) {
        // A tenant DB that isn't provisioned yet (or has no users table) shouldn't
        // break the whole list — just skip it and keep going.
        console.warn(`[pending-users] skipped ${company.slug}:`, e.message);
      }
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/masteradmin/pending-users/:companySlug/:userId — approve/reject ───
// Body: { status: 'active' | 'rejected' }
router.patch('/pending-users/:companySlug/:userId', requireMasterAdmin, async (req, res) => {
  try {
    const { getTenantDbByName } = require('../db/tenantConnections');
    const { status } = req.body;
    if (!['active', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'rejected'" });
    }
    const company = await coreDb('companies').where({ slug: req.params.companySlug }).first();
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const db = getTenantDbByName(company.db_name);
    await db('users').where({ id: req.params.userId }).update({ status, updated_at: new Date() });
    const user = await db('users').where({ id: req.params.userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { password_hash, ...safe } = user;
    // Same real-time event the tenant's own admin screen listens for, so
    // if their own superadmin has that page open too it updates live.
    if (req.io) req.io.to(company.slug).emit('user:updated', safe);
    res.json({ ...safe, company_name: company.name, company_slug: company.slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/masteradmin/admins — create a new platform admin ───────────────
router.post('/admins', requireMasterAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    const existing = await coreDb('platform_admins').where({ email: email.toLowerCase() }).first();
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const password_hash = await hashPassword(password);
    await coreDb('platform_admins').insert({ name, email: email.toLowerCase(), password_hash, status: 'active' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;