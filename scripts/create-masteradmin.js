/**
 * One-time script to create the first platform admin account.
 * Run from the backend folder:
 *   node scripts/create-masteradmin.js
 */
require('dotenv').config();
const coreDb = require('../src/db/core');
const { hashPassword } = require('../src/utils/auth');

const NAME     = process.env.MA_NAME     || 'Master Admin';
const EMAIL    = process.env.MA_EMAIL    || 'masteradmin@ogplus.com';
const PASSWORD = process.env.MA_PASSWORD || 'Admin@1234';

(async () => {
  try {
    const existing = await coreDb('platform_admins').where({ email: EMAIL.toLowerCase() }).first();
    if (existing) {
      console.log(`✓ Platform admin already exists: ${EMAIL}`);
      process.exit(0);
    }
    const hash = await hashPassword(PASSWORD);
    await coreDb('platform_admins').insert({
      name: NAME,
      email: EMAIL.toLowerCase(),
      password_hash: hash,
      status: 'active',
    });
    console.log(`\n✓ Platform admin created`);
    console.log(`  Email:    ${EMAIL}`);
    console.log(`  Password: ${PASSWORD}`);
    console.log(`  → Change this password after first login!\n`);
  } catch(e) {
    console.error('✗ Failed:', e.message);
  } finally {
    await coreDb.destroy();
  }
})();