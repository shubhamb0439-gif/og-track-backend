/**
 * One-time (or re-runnable) setup for AIDA's phase-2 module-builder preview
 * database — see docs/AIDA_PHASE2_MODULE_BUILDER_PLAN.md. Creates ONE fixed
 * Azure SQL database that plays the role of BOTH OGCore (just the companies
 * table, enough for tenant lookup) AND one tenant's own database (the full
 * business schema) at once, seeded with one company row and one login, so
 * every create_module job's live preview has somewhere real to connect and
 * something to log into.
 *
 * Deliberately reuses the SAME Azure SQL server/user/password already
 * configured for the real app (AZURE_SQL_SERVER/USER/PASSWORD) — this is
 * just one more database on that server, not a separate credential to
 * create and manage. Only a NEW env var is required: AIDA_STAGING_SQL_DATABASE
 * (the database name itself). Safe to re-run: every step here either
 * IF-NOT-EXISTS-guards itself or is caught/skipped as "already exists",
 * exactly like the real provisionTenant() flow it borrows from.
 *
 * Run from the backend folder:
 *   node scripts/provisionStagingDb.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const config = require('../src/config');
const { hashPassword } = require('../src/utils/auth');
const { MODULE_TO_SCRIPT, runSqlFileAgainstPool, SQL_DIR } = require('../src/utils/provisioning');

const DB_NAME = process.env.AIDA_STAGING_SQL_DATABASE;
const ADMIN_EMAIL = process.env.AIDA_STAGING_ADMIN_EMAIL || 'preview@ogtrack.local';
const ADMIN_PASSWORD = process.env.AIDA_STAGING_ADMIN_PASSWORD || 'AidaPreview@2024';
const COMPANY_SLUG = process.env.AIDA_STAGING_COMPANY_SLUG || 'aida-preview';
const CORE_SQL_DIR = path.resolve(__dirname, '../ogtrack-sql-schema/core');

async function run() {
  if (!DB_NAME) {
    console.error('✗ AIDA_STAGING_SQL_DATABASE is not set — add it to .env first (just a database name, e.g. "aida_module_preview").');
    process.exit(1);
  }

  // ── 1. CREATE DATABASE (same server/creds/tier as real tenant provisioning) ──
  console.log(`Creating database [${DB_NAME}] on ${config.sql.server} (serverless tier)...`);
  let masterPool = await sql.connect({
    server: config.sql.server, port: config.sql.port, user: config.sql.user, password: config.sql.password,
    database: 'master', requestTimeout: 120000, connectionTimeout: 30000,
    options: { encrypt: config.sql.encrypt, trustServerCertificate: config.sql.trustServerCertificate },
  });
  await masterPool.request().query(
    `IF DB_ID(N'${DB_NAME}') IS NULL
     CREATE DATABASE [${DB_NAME}]
     (EDITION = 'GeneralPurpose', SERVICE_OBJECTIVE = 'GP_S_Gen5_1', MAXSIZE = 32GB)`
  );
  await masterPool.close();
  console.log('✓ Database ready.');

  // ── 2. Connect to the new database and run every schema file it needs ────────
  const pool = await sql.connect({
    server: config.sql.server, port: config.sql.port, user: config.sql.user, password: config.sql.password,
    database: DB_NAME, requestTimeout: 60000, connectionTimeout: 30000,
    options: { encrypt: config.sql.encrypt, trustServerCertificate: config.sql.trustServerCertificate },
  });

  console.log('Running core schema (companies table)...');
  await runOneFile(pool, path.join(CORE_SQL_DIR, '00_platform_core_companies.sql'));

  console.log('Running full tenant schema (every module, so any new module can preview regardless of dependencies)...');
  const tenantFiles = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of tenantFiles) {
    const result = await runOneFile(pool, path.join(SQL_DIR, file));
    console.log(`  ${file}: ${result.failed ? `${result.failed} FAILED` : 'ok'} (${result.skipped} already existed)`);
  }

  // ── 3. Seed one company row (self-referential db_name — this DB plays both roles) ──
  console.log('Seeding preview company row...');
  const existingCompany = await pool.request().input('slug', sql.NVarChar, COMPANY_SLUG)
    .query('SELECT id FROM dbo.companies WHERE slug = @slug');
  let companyId;
  if (existingCompany.recordset.length) {
    companyId = existingCompany.recordset[0].id;
    console.log(`✓ Company row already exists (${COMPANY_SLUG}).`);
  } else {
    const allModuleKeys = JSON.stringify(Object.keys(MODULE_TO_SCRIPT));
    const inserted = await pool.request()
      .input('name', sql.NVarChar, 'AIDA Preview')
      .input('slug', sql.NVarChar, COMPANY_SLUG)
      .input('db_name', sql.NVarChar, DB_NAME)
      .input('enabled_modules', sql.NVarChar, allModuleKeys)
      .query(`INSERT INTO dbo.companies (name, slug, db_name, status, enabled_modules, custom_modules, provisioned_at)
              OUTPUT INSERTED.id
              VALUES (@name, @slug, @db_name, 'active', @enabled_modules, '[]', SYSUTCDATETIME())`);
    companyId = inserted.recordset[0].id;
    console.log(`✓ Company row created (${COMPANY_SLUG}), every module enabled so nothing gets gated out.`);
  }

  // ── 4. Seed one login so a preview is actually usable ─────────────────────────
  const existingUser = await pool.request().input('email', sql.NVarChar, ADMIN_EMAIL.toLowerCase())
    .query('SELECT id FROM dbo.users WHERE email = @email');
  if (existingUser.recordset.length) {
    console.log(`✓ Login already exists: ${ADMIN_EMAIL}`);
  } else {
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const userId = 'u' + Date.now();
    await pool.request()
      .input('id', sql.NVarChar, userId)
      .input('name', sql.NVarChar, 'AIDA Preview Admin')
      .input('email', sql.NVarChar, ADMIN_EMAIL.toLowerCase())
      .input('password_hash', sql.NVarChar, passwordHash)
      .query(`INSERT INTO dbo.users (id, name, email, password_hash, role, status)
              VALUES (@id, @name, @email, @password_hash, 'superadmin', 'active')`);
    console.log(`✓ Login created — email: ${ADMIN_EMAIL} / password: ${ADMIN_PASSWORD}`);
  }

  await pool.close();
  console.log(`\nStaging DB ready. Set AIDA_STAGING_SQL_DATABASE=${DB_NAME} in .env (server/user/password reuse AZURE_SQL_SERVER/USER/PASSWORD automatically).`);
}

async function runOneFile(pool, absPath) {
  if (!fs.existsSync(absPath)) return { skipped: 0, failed: 0, failureMessages: [`File not found: ${absPath}`] };
  const result = await runSqlFileAgainstPool(pool, absPath);
  if (result.failed) console.error(`  ! ${path.basename(absPath)}:`, result.failureMessages.join(' | '));
  return result;
}

run()
  .then(() => process.exit(0))
  .catch((e) => { console.error('✗ Failed:', e.message); process.exit(1); });
