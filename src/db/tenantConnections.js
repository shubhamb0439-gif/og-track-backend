const knex = require('knex');
const config = require('../config');
const coreDb = require('./core');

/**
 * Cache of live Knex instances, keyed by tenant database name (db_name).
 * Each tenant gets ONE pooled connection object, reused across every
 * request for that tenant — we never open a fresh connection per request.
 * This map lives for the lifetime of the Node process.
 */
const tenantKnexCache = new Map();

/**
 * Cache of company rows keyed by slug, with a short TTL so masteradmin
 * changes (e.g. suspending a company, enabling a new module) take effect
 * within a few seconds rather than requiring a server restart, without
 * hitting OGCore on every single request.
 */
const companyCache = new Map(); // slug -> { company, expiresAt }
const COMPANY_CACHE_TTL_MS = 30 * 1000;

/**
 * Look up a company by slug from OGCore. Throws a typed error the route
 * layer can turn into a proper 404/403 HTTP response.
 */
async function getCompanyBySlug(slug) {
  const cached = companyCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.company;

  const company = await coreDb('companies').where({ slug }).first();
  if (!company) {
    const err = new Error(`No company found for slug "${slug}"`);
    err.statusCode = 404;
    throw err;
  }
  if (company.status !== 'active') {
    const err = new Error(`Company "${slug}" is ${company.status}`);
    err.statusCode = 403;
    throw err;
  }

  // enabled_modules comes back as a JSON string from SQL Server; parse once here.
  company.enabled_modules = JSON.parse(company.enabled_modules || '[]');
  company.custom_modules = company.custom_modules ? JSON.parse(company.custom_modules) : [];

  companyCache.set(slug, { company, expiresAt: Date.now() + COMPANY_CACHE_TTL_MS });
  return company;
}

/**
 * Get (or lazily create) the pooled Knex connection for a given tenant
 * database name. Safe to call frequently — cache hit is just a Map lookup.
 */
function getTenantDbByName(dbName) {
  if (tenantKnexCache.has(dbName)) return tenantKnexCache.get(dbName);

  const instance = knex({
    client: 'mssql',
    connection: {
      server: config.sql.server,
      port: config.sql.port,
      user: config.sql.user,
      password: config.sql.password,
      database: dbName,
      options: {
        encrypt: config.sql.encrypt,
        trustServerCertificate: config.sql.trustServerCertificate,
      },
    },
    pool: { min: 0, max: 10 },
  });

  tenantKnexCache.set(dbName, instance);
  return instance;
}

/**
 * The one function most routes will call: given a slug, get back both the
 * company record (for branding/module-gating) and a ready-to-query Knex
 * instance pointed at that tenant's own database.
 */
async function resolveTenant(slug) {
  const company = await getCompanyBySlug(slug);
  const db = getTenantDbByName(company.db_name);
  return { company, db };
}

/** Invalidate a cached company row immediately, e.g. right after a masteradmin edit. */
function invalidateCompanyCache(slug) {
  companyCache.delete(slug);
}

module.exports = { resolveTenant, getCompanyBySlug, getTenantDbByName, invalidateCompanyCache };
