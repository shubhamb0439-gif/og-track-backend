const { UNIVERSAL_SENTINEL_MODULE } = require('../../contextBuilder');

/**
 * Generic, pure data-transform tool: join two already-fetched arrays of
 * plain objects on a key, optionally filter the matches, and optionally
 * project each match down to a specific shape — all in-memory, no external
 * API calls of its own. Meant for the common "I pulled list A from one tool
 * and list B from another, now I need to cross-reference them" step (e.g.
 * matching invoices against payments, employees against attendance records,
 * leads against deals) without the model having to hand-roll join/filter
 * logic in prose.
 *
 * Available in EVERY context (tenant or masteradmin) via the universal
 * sentinel — it only operates on the arrays it's given, same reasoning as
 * render_chart in dataViz.js.
 */

const OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
};

function passesFilters(rightRow, rightFilters) {
  if (!Array.isArray(rightFilters) || rightFilters.length === 0) return true;
  return rightFilters.every(({ field, op, value }) => {
    const fn = OPS[op];
    if (!fn) return false; // unknown op — fail closed rather than silently match everything
    return fn(rightRow ? rightRow[field] : undefined, value);
  });
}

function buildRow(leftRow, rightRow, projectFields) {
  if (!Array.isArray(projectFields) || projectFields.length === 0) {
    return { ...leftRow, ...rightRow };
  }
  const out = {};
  for (const { as, from, field } of projectFields) {
    const source = from === 'right' ? rightRow : leftRow;
    out[as] = source ? source[field] : undefined;
  }
  return out;
}

function summarize(matches) {
  if (!matches.length) return 'No matches found.';
  const lines = matches.map((row, i) => {
    const parts = Object.entries(row).map(([k, v]) => `${k}: ${v === null || v === undefined ? '—' : v}`);
    return `${i + 1}. ${parts.join(', ')}`;
  });
  return `${matches.length} match${matches.length === 1 ? '' : 'es'} found:\n${lines.join('\n')}`;
}

module.exports = [
  {
    name: 'compare_datasets',
    category: 'Custom Actions',
    description:
      'Joins two arrays of plain objects you already have (e.g. results from two earlier tool calls) on a key, ' +
      'optionally filters the matches, and builds output rows from them — a generic, pure in-memory data-transform ' +
      'tool that never calls any external API itself. For each left row, finds right rows where ' +
      'rightRow[rightKey] === leftRow[leftKey]; among those, keeps only ones passing every rightFilters condition ' +
      '(op is one of eq/neq/gt/lt); for each surviving match builds one output row via projectFields (pulling ' +
      '`field` from whichever side `from` says, named `as`), or if projectFields is omitted, merges the full left+' +
      'right objects together. Returns {count, matches, summary} where summary is short, human-readable text ' +
      'listing each match on its own line, ready to paste directly into a WhatsApp message.',
    requiredModules: [UNIVERSAL_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        leftRows: { type: 'array', items: { type: 'object' }, description: 'Left-side array of plain objects to join from.' },
        rightRows: { type: 'array', items: { type: 'object' }, description: 'Right-side array of plain objects to join against.' },
        leftKey: { type: 'string', description: 'Field name on each left row to join on.' },
        rightKey: { type: 'string', description: 'Field name on each right row to join on.' },
        rightFilters: {
          type: 'array',
          description: 'Optional extra conditions a matched right row must all pass to be kept.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Field name on the right row to test.' },
              op: { type: 'string', enum: ['eq', 'neq', 'gt', 'lt'], description: 'Comparison operator.' },
              value: { description: 'Value to compare rightRow[field] against.' },
            },
            required: ['field', 'op', 'value'],
          },
        },
        projectFields: {
          type: 'array',
          description: 'Optional — how to build each output row. If omitted, the full left+right objects are merged instead.',
          items: {
            type: 'object',
            properties: {
              as: { type: 'string', description: 'Key name in the output row.' },
              from: { type: 'string', enum: ['left', 'right'], description: 'Which side to pull the value from.' },
              field: { type: 'string', description: 'Field name on that side\'s row.' },
            },
            required: ['as', 'from', 'field'],
          },
        },
      },
      required: ['leftRows', 'rightRows', 'leftKey', 'rightKey'],
    },
    async handler(_context, { leftRows, rightRows, leftKey, rightKey, rightFilters, projectFields } = {}) {
      if (!Array.isArray(leftRows)) return { error: 'leftRows must be an array of objects.' };
      if (!Array.isArray(rightRows)) return { error: 'rightRows must be an array of objects.' };
      if (!leftKey || typeof leftKey !== 'string') return { error: 'leftKey must be a non-empty string.' };
      if (!rightKey || typeof rightKey !== 'string') return { error: 'rightKey must be a non-empty string.' };

      const matches = [];
      for (const leftRow of leftRows) {
        const leftVal = leftRow ? leftRow[leftKey] : undefined;
        const candidateMatches = rightRows.filter((rightRow) => rightRow && rightRow[rightKey] === leftVal);
        for (const rightRow of candidateMatches) {
          if (!passesFilters(rightRow, rightFilters)) continue;
          matches.push(buildRow(leftRow, rightRow, projectFields));
        }
      }

      return { count: matches.length, matches, summary: summarize(matches) };
    },
  },
];
