/**
 * The original frontend speaks camelCase (shortCode, projectId, fixSummary, ...)
 * and sends extra relational-ish fields (managers[], developers[], testers[]).
 * The SQL schema uses snake_case columns plus an `extra_json` overflow column.
 *
 * splitKnown() takes the request body, a map of {camelOrSnakeKey -> db_column},
 * and returns { known, extra } where:
 *   - known = only the recognized columns, keyed by their real DB column name
 *   - extra = everything else (to be JSON.stringify'd into extra_json)
 *
 * This keeps the frontend untouched while the backend stays clean and typed.
 */
function splitKnown(body, fieldMap) {
  const known = {};
  const extra = {};
  const mappedSourceKeys = new Set(Object.keys(fieldMap));

  for (const [key, value] of Object.entries(body || {})) {
    if (mappedSourceKeys.has(key)) {
      known[fieldMap[key]] = value;
    } else {
      extra[key] = value;
    }
  }
  return { known, extra };
}

/** Serialize the extra object for storage, or null if empty. */
function packExtra(extra) {
  return extra && Object.keys(extra).length ? JSON.stringify(extra) : null;
}

/** Merge a DB row's extra_json back into a flat object for the API response.
 *  Also adds camelCase aliases for a few snake_case columns the original
 *  frontend reads directly (shortCode, projectId, projectName, fixSummary),
 *  so display code keeps working without edits. */
function unpackRow(row) {
  if (!row) return row;
  const { extra_json, ...rest } = row;
  const extra = extra_json ? safeParse(extra_json) : {};
  const merged = { ...rest, ...extra };
  // camelCase aliases (only when the snake_case column is present)
  if ('short_code' in rest) merged.shortCode = rest.short_code;
  if ('project_id' in rest) merged.projectId = rest.project_id;
  if ('project_name' in rest) merged.projectName = rest.project_name;
  if ('fix_summary' in rest) merged.fixSummary = rest.fix_summary;
  return merged;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { splitKnown, packExtra, unpackRow };
