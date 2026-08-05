require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Check your .env file (see .env.example).`);
  return v;
}

// Multiple SQL logical servers, one per Azure region you've set up, so
// masteradmin can pick where a new company's database gets created.
// AZURE_SQL_REGIONS is optional JSON, e.g.:
//   [{"key":"eastus","label":"East US","server":"ogtrack-sql-eastus.database.windows.net"}]
// Each entry can optionally override user/password; otherwise it reuses the
// main AZURE_SQL_USER/PASSWORD (the normal case when one admin login was
// used to create every regional server).
function buildSqlRegions() {
  const regions = {
    default: {
      key: 'default',
      label: process.env.AZURE_SQL_DEFAULT_REGION_LABEL || 'Default',
      server: required('AZURE_SQL_SERVER'),
      user: required('AZURE_SQL_USER'),
      password: required('AZURE_SQL_PASSWORD'),
    },
  };
  if (process.env.AZURE_SQL_REGIONS) {
    try {
      const extra = JSON.parse(process.env.AZURE_SQL_REGIONS);
      extra.forEach(r => {
        if (!r.key || !r.server) return;
        regions[r.key] = {
          key: r.key,
          label: r.label || r.key,
          server: r.server,
          user: r.user || regions.default.user,
          password: r.password || regions.default.password,
        };
      });
    } catch (e) {
      console.error('[config] AZURE_SQL_REGIONS is not valid JSON, ignoring:', e.message);
    }
  }
  return regions;
}

module.exports = {
  sql: {
    server: required('AZURE_SQL_SERVER'),
    port: parseInt(process.env.AZURE_SQL_PORT || '1433', 10),
    user: required('AZURE_SQL_USER'),
    password: required('AZURE_SQL_PASSWORD'),
    encrypt: (process.env.AZURE_SQL_ENCRYPT || 'true') === 'true',
    trustServerCertificate: (process.env.AZURE_SQL_TRUST_SERVER_CERT || 'false') === 'true',
    coreDatabase: process.env.AZURE_SQL_CORE_DB || 'OGCore',
    regions: buildSqlRegions(),
  },
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    qrSecret: process.env.QR_SECRET || 'ogtrack-qr-att-2024',
    jwtSecret: required('JWT_SECRET'),
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  },
  // AIDA (AI orchestration layer) — intentionally NOT using required() here.
  // Every other module in this app is core to running OGTrack at all, so a
  // missing env var should fail startup loudly. AIDA is an optional layer on
  // top of the existing product; if this key is absent, AIDA should report
  // itself as unavailable to the frontend rather than crash the whole server.
  aida: {
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
};