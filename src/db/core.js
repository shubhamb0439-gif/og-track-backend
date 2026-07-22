const knex = require('knex');
const config = require('../config');

// OGCore is a single, fixed connection — every request that needs the
// tenant registry (slug lookups, masteradmin company CRUD) uses this.
const coreDb = knex({
  client: 'mssql',
  connection: {
    server: config.sql.server,
    port: config.sql.port,
    user: config.sql.user,
    password: config.sql.password,
    database: config.sql.coreDatabase,
    options: {
      encrypt: config.sql.encrypt,
      trustServerCertificate: config.sql.trustServerCertificate,
    },
  },
  pool: { min: 0, max: 10 },
});

module.exports = coreDb;
