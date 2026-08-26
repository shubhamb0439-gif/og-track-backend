/**
 * provisionTenant — creates a new Azure SQL database and runs the
 * tenant schema scripts for the enabled modules.
 *
 * Called async/background from POST /api/masteradmin/companies so the
 * HTTP response returns immediately while provisioning continues.
 * Progress is written to OGCore.provisioning_log.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sql = require('mssql');
const coreDb = require('../db/core');
const config = require('../config');

// Which SQL file covers each module key
const MODULE_TO_SCRIPT = {
  dashboard:      '01_core_tenant.sql',
  admin:          '01_core_tenant.sql',
  roles:          '01_core_tenant.sql',
  projects:       '02_module_projects.sql',
  sprints:        '02_module_projects.sql',
  bugs:           '02_module_projects.sql',
  sub_tickets:    '03_module_requests.sql',
  attendance:     '04_module_attendance.sql',
  history:        '04_module_attendance.sql',
  messages:       '05_module_messaging.sql',
  acc_clients:    '06_module_accounting.sql',
  acc_timer:      '06_module_accounting.sql',
  acc_eod:        '06_module_accounting.sql',
  hr_dashboard:   '07_module_hr.sql',
  hr_jobs:        '07_module_hr.sql',
  hr_candidates:  '07_module_hr.sql',
  hr_interviews:  '07_module_hr.sql',
  crm:            '08_module_crm.sql',
  inventory:      '09_module_inventory.sql',
  manufacturing:  '10_module_manufacturing.sql',
  sales:          '11_module_sales.sql',
  test_cases:     '12_module_test_cases.sql',
  to_do_list:     '13_module_to_do_list.sql',
  token:          '14_module_token.sql',
  notes:          '15_module_notes.sql',
  birthday_module: '16_module_birthday_module.sql',
};

// Some modules' tables have foreign keys into another module's tables (e.g.
// Manufacturing's BOMs reference Inventory's items). If a company somehow
// gets 'manufacturing' enabled without 'inventory', schema creation would
// fail on the FK. This makes sure the dependency's script always runs too.
const MODULE_DEPENDENCIES = {
  manufacturing: ['inventory'],
  sales: ['crm', 'inventory', 'manufacturing'],
};

// Scripts directory — adjust path if you move the sql folder
const SQL_DIR = path.resolve(__dirname, '../../ogtrack-sql-schema/tenant');

async function log(companyId, step, status, detail = null) {
  try {
    await coreDb('provisioning_log').insert({ company_id: companyId, step, status, detail });
  } catch (e) {
    console.error('[provisioning] log write failed:', e.message);
  }
}

// A short, readable-ish random password for the one-time handoff — not meant
// to be permanent, just enough to get the client's admin logged in the first
// time so they can set their own password afterward.
function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) + '!1';
}

// True if the error is SQL Server's "already exists" complaint — safe to
// skip rather than treat as a real failure, which is what makes re-running
// scripts on an existing tenant DB safe instead of destructive.
//
// SQL Server surfaces failures with genuinely different wording depending on
// what's being created, AND wraps some errors in a generic outer error that
// hides the real cause. Specifically:
//   - duplicate TABLE:      "There is already an object named 'X' ..."
//   - duplicate INDEX:      "... already exists on table 'X'."
//   - duplicate CONSTRAINT: outer error is a generic "Could not create
//                          constraint or index. See previous errors." —
//                          the real "already exists" text is stashed on a
//                          NESTED property (precedingErrors / originalError
//                          / errors / info — mssql picks inconsistently
//                          depending on error type).
//
// Rather than enumerate every property name, walk the whole error object
// recursively and match on ANY string that looks like an "already exists"
// message. This is the same idea as JSON.stringify(e) then regex-searching,
// but avoids circular-ref issues and doesn't need to know the driver's
// internals.
function isAlreadyExistsError(e) {
  const patterns = [
    /there is already an object named/i,
    /already exists on table/i,
    /already exists/i,
    /is already present in the object/i,
    /msg\s*2714|msg\s*1913|msg\s*2705/i,
  ];
  const codes = new Set([2714, 1913, 2705]);

  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (typeof node.number === 'number' && codes.has(node.number)) return true;
    for (const val of Object.values(node)) {
      if (typeof val === 'string' && patterns.some(p => p.test(val))) return true;
      if (Array.isArray(val)) { for (const item of val) if (walk(item)) return true; }
      else if (typeof val === 'object' && walk(val)) return true;
    }
    return false;
  }
  return walk(e);
}

/**
 * Runs whichever schema scripts a set of module keys need, against an
 * ALREADY-CONNECTED tenant pool. Safe to call more than once for the same
 * company — statements that fail because the object already exists are
 * logged as 'skipped' rather than 'failed', so adding a module to a company
 * that's already provisioned (e.g. via the Edit modal, after creation) can
 * just re-run this to create only what's missing.
 */
async function runSchemaScripts(tenantPool, companyId, slug, moduleKeys, { alwaysIncludeCore = true } = {}) {
  const expandedModules = new Set(moduleKeys);
  for (const mod of moduleKeys) {
    (MODULE_DEPENDENCIES[mod] || []).forEach(dep => expandedModules.add(dep));
  }
  const scriptsNeeded = new Set(alwaysIncludeCore ? ['01_core_tenant.sql'] : []);
  for (const mod of expandedModules) {
    const script = MODULE_TO_SCRIPT[mod];
    if (script) scriptsNeeded.add(script);
  }
  const orderedScripts = ['01_core_tenant.sql','02_module_projects.sql',
    '03_module_requests.sql','04_module_attendance.sql','05_module_messaging.sql',
    '06_module_accounting.sql','07_module_hr.sql','08_module_crm.sql','09_module_inventory.sql',
    '10_module_manufacturing.sql','11_module_sales.sql','12_module_test_cases.sql'].filter(s => scriptsNeeded.has(s));
  // New modules appended here (rather than inlined above) so the original
  // literal above never needs to be modified — see MODULE_TO_SCRIPT for the
  // module -> script mapping.
  if (scriptsNeeded.has('13_module_to_do_list.sql')) orderedScripts.push('13_module_to_do_list.sql');
  if (scriptsNeeded.has('14_module_token.sql')) orderedScripts.push('14_module_token.sql');
  if (scriptsNeeded.has('15_module_notes.sql')) orderedScripts.push('15_module_notes.sql');
  if (scriptsNeeded.has('16_module_birthday_module.sql')) orderedScripts.push('16_module_birthday_module.sql');

  for (const scriptFile of orderedScripts) {
    const step = `run_${scriptFile}`;
    await log(companyId, step, 'pending');
    const scriptPath = path.join(SQL_DIR, scriptFile);
    if (!fs.existsSync(scriptPath)) {
      await log(companyId, step, 'failed', `File not found: ${scriptPath}`);
      continue;
    }
    const { skipped, failed, failureMessages, totalBatches } = await runSqlFileAgainstPool(tenantPool, scriptPath);
    if (failed > 0) {
      await log(companyId, step, 'failed', `${failed} statement(s) failed, ${skipped} already existed — ${failureMessages.join(' | ')}`);
    } else if (skipped === totalBatches) {
      await log(companyId, step, 'success', 'Already up to date — nothing new to create');
    } else {
      await log(companyId, step, 'success', skipped ? `${skipped} object(s) already existed, rest created` : undefined);
    }
    console.log(`[provisioning] ${slug}: ${scriptFile} done (skipped ${skipped}, failed ${failed})`);
  }
}

/**
 * Runs one .sql file's GO-separated batches against an already-connected
 * pool, skipping "already exists" failures exactly like runSchemaScripts
 * above (extracted so a single ad-hoc file — e.g. a module-builder agent's
 * brand-new, not-yet-merged schema file — can be run the same safe way
 * without needing a companyId/provisioning_log entry, which is what
 * runSchemaScripts itself needs since it's always logging progress for a
 * real company's provisioning run).
 */
async function runSqlFileAgainstPool(pool, absPath) {
  const sqlText = fs.readFileSync(absPath, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);
  let skipped = 0, failed = 0;
  const failureMessages = [];
  for (const batch of batches) {
    try {
      await pool.request().query(batch);
    } catch (e) {
      if (isAlreadyExistsError(e)) { skipped++; continue; }
      failed++;
      failureMessages.push(e.message);
    }
  }
  return { skipped, failed, failureMessages, totalBatches: batches.length };
}

async function provisionTenant(company, enabledModules, adminInfo = null) {
  const { id: companyId, db_name, slug } = company;
  const regionKey = company.sql_region || 'default';
  const region = config.sql.regions[regionKey] || config.sql.regions.default;
  console.log(`[provisioning] starting for ${slug} → ${db_name} (region: ${region.key})`);

  // ── 1. CREATE DATABASE ────────────────────────────────────────────────────
  await log(companyId, 'create_database', 'pending');
  let masterPool;
  try {
    masterPool = await sql.connect({
      server: region.server,
      port: config.sql.port,
      user: region.user,
      password: region.password,
      database: 'master',           // connect to master to CREATE DATABASE
      requestTimeout: 120000,       // 2 min — CREATE DATABASE on Azure SQL can take ~60s
      connectionTimeout: 30000,
      options: {
        encrypt: config.sql.encrypt,
        trustServerCertificate: config.sql.trustServerCertificate,
      },
    });
    // Azure SQL doesn't support GO batches via mssql driver — use simple statements.
    // IMPORTANT: without an explicit EDITION/SERVICE_OBJECTIVE, Azure SQL
    // silently defaults new databases to provisioned General Purpose compute
    // (running dedicated vCores 24/7 — roughly $400+/month each). Every
    // tenant here is small and low-traffic, so match the Serverless tier
    // used for manually-created databases instead: auto-pauses when idle,
    // bills per-second while active. Serverless databases default to a
    // 1-hour auto-pause delay automatically — no extra statement needed.
    await masterPool.request().query(
      `IF DB_ID(N'${db_name}') IS NULL
       CREATE DATABASE [${db_name}]
       (EDITION = 'GeneralPurpose', SERVICE_OBJECTIVE = 'GP_S_Gen5_1', MAXSIZE = 32GB)`
    );
    await log(companyId, 'create_database', 'success', `Database [${db_name}] ready on ${region.label} (${region.server})`);
    console.log(`[provisioning] ${db_name} database created/verified on ${region.server}`);
  } catch (e) {
    await log(companyId, 'create_database', 'failed', e.message);
    console.error(`[provisioning] create_database failed:`, e.message);
    await masterPool?.close().catch(() => {});
    return;
  }
  await masterPool.close().catch(() => {});

  // ── 2. Run schema scripts ─────────────────────────────────────────────────
  let tenantPool;
  try {
    tenantPool = await sql.connect({
      server: region.server,
      port: config.sql.port,
      user: region.user,
      password: region.password,
      database: db_name,
      requestTimeout: 60000,        // 60s per schema script batch
      connectionTimeout: 30000,
      options: {
        encrypt: config.sql.encrypt,
        trustServerCertificate: config.sql.trustServerCertificate,
      },
    });

    await runSchemaScripts(tenantPool, companyId, slug, enabledModules);

    // ── Seed the first superadmin account ─────────────────────────────────
    // A brand-new tenant's users table is empty. Normal registration puts
    // people in 'pending' status waiting for a superadmin to approve them —
    // but with zero users, nobody could ever get past that. This creates
    // that first account directly as 'active' so the client has a way in.
    if (adminInfo && adminInfo.adminEmail) {
      const step = 'seed_admin';
      await log(companyId, step, 'pending');
      try {
        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, config.app.bcryptRounds);
        const userId = 'u' + Date.now();
        await tenantPool.request()
          .input('id', sql.NVarChar, userId)
          .input('name', sql.NVarChar, adminInfo.adminName || 'Admin')
          .input('email', sql.NVarChar, adminInfo.adminEmail.toLowerCase())
          .input('password_hash', sql.NVarChar, passwordHash)
          .query(`INSERT INTO dbo.users (id, name, email, password_hash, role, status)
                  VALUES (@id, @name, @email, @password_hash, 'superadmin', 'active')`);
        // The ONLY place this plaintext password is ever written. It's visible
        // to platform admins via the company's "Log" button — hand it to the
        // client and have them change it on first login.
        await log(companyId, step, 'success',
          `Superadmin created — email: ${adminInfo.adminEmail.toLowerCase()} / temp password: ${tempPassword} (share once, then have them change it)`);
        console.log(`[provisioning] ${slug}: seed_admin ✓ (${adminInfo.adminEmail})`);
      } catch (e) {
        await log(companyId, step, 'failed', e.message);
        console.error(`[provisioning] ${slug}: seed_admin FAILED:`, e.message);
      }
    }
  } catch (e) {
    await log(companyId, 'connect_tenant_db', 'failed', e.message);
    console.error(`[provisioning] tenant DB connect failed:`, e.message);
  } finally {
    await tenantPool?.close().catch(() => {});
  }

  // ── 3. Mark provisioned ───────────────────────────────────────────────────
  await coreDb('companies').where({ id: companyId }).update({ provisioned_at: new Date() });
  await log(companyId, 'provisioning_complete', 'success', `All scripts executed for ${slug}`);
  console.log(`[provisioning] ${slug} complete`);
}

/**
 * For a company that's already provisioned: connect to its existing tenant
 * DB and run schema scripts for whichever modules it currently has enabled.
 * Safe to call anytime after changing a company's modules (e.g. from the
 * Edit modal) — already-existing tables/indexes are skipped, not recreated.
 */
async function provisionModulesForExistingCompany(company, moduleKeys) {
  const { id: companyId, db_name, slug } = company;
  const regionKey = company.sql_region || 'default';
  const region = config.sql.regions[regionKey] || config.sql.regions.default;
  let tenantPool;
  try {
    tenantPool = await sql.connect({
      server: region.server,
      port: config.sql.port,
      user: region.user,
      password: region.password,
      database: db_name,
      requestTimeout: 60000,
      connectionTimeout: 30000,
      options: {
        encrypt: config.sql.encrypt,
        trustServerCertificate: config.sql.trustServerCertificate,
      },
    });
    await runSchemaScripts(tenantPool, companyId, slug, moduleKeys);
    console.log(`[provisioning] ${slug}: module re-provision complete`);
  } catch (e) {
    await log(companyId, 'connect_tenant_db', 'failed', e.message);
    console.error(`[provisioning] ${slug}: module re-provision connect failed:`, e.message);
    throw e;
  } finally {
    await tenantPool?.close().catch(() => {});
  }
}

module.exports = {
  provisionTenant, provisionModulesForExistingCompany, MODULE_TO_SCRIPT, MODULE_DEPENDENCIES,
  runSqlFileAgainstPool, isAlreadyExistsError, generateTempPassword, SQL_DIR,
};
