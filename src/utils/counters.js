/**
 * Concurrency-safe "give me the next number for this counter" — the SQL
 * equivalent of the old Firestore db.runTransaction() counter pattern.
 * Uses WITH (UPDLOCK, HOLDLOCK) so two simultaneous requests for the same
 * counter_key can't both read the same value and collide.
 *
 * @param {import('knex').Knex} db  - tenant Knex instance
 * @param {string} counterKey       - e.g. 'counter_PRJ', 'sub_ticket_counter'
 * @returns {Promise<number>}
 */
async function nextCounter(db, counterKey) {
  return db.transaction(async (trx) => {
    const result = await trx.raw(
      `SELECT current_value FROM dbo.id_counters WITH (UPDLOCK, HOLDLOCK) WHERE counter_key = ?`,
      [counterKey]
    );
    // mssql driver via knex returns the recordset directly as an array.
    const rows = Array.isArray(result) ? result : (result.rows || result);
    const existing = rows && rows[0] ? rows[0].current_value : null;

    let next;
    if (existing === null || existing === undefined) {
      next = 1;
      await trx.raw(`INSERT INTO dbo.id_counters (counter_key, current_value) VALUES (?, ?)`, [counterKey, next]);
    } else {
      next = existing + 1;
      await trx.raw(`UPDATE dbo.id_counters SET current_value = ? WHERE counter_key = ?`, [next, counterKey]);
    }
    return next;
  });
}

/** Formats a counter value into the old human-readable codes, e.g. nextBugId('PRJ', 7) -> 'PRJ-007' */
function formatCode(prefix, value, padLength = 3) {
  return `${prefix}-${String(value).padStart(padLength, '0')}`;
}

module.exports = { nextCounter, formatCode };
