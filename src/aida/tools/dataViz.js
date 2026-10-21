const { UNIVERSAL_SENTINEL_MODULE } = require('../contextBuilder');

/**
 * "Show me a pie chart of X" — AIDA's reply is plain text, and the frontend
 * already auto-renders any real URL appearing in it as a preview card
 * (routes/aida.js's masteradmin_open_company tool/prompt is the other half
 * of that same pattern). This is the chart equivalent: a NEW fenced code
 * block convention (```aida-chart ... ```) the frontend will need to detect
 * and render — see docs/FRONTEND_PROMPTS.md #41 for that half.
 *
 * This tool does NOT fetch or know any real data itself — it only validates
 * and canonicalizes numbers the model already pulled from a real data tool
 * earlier in the same turn, exactly the way masteradmin_open_company
 * resolves a company deterministically instead of trusting the model's own
 * guess. The model must copy the returned `replyBlock` VERBATIM into its
 * reply (engine.js's system prompt says so explicitly) — hand-retyping the
 * JSON itself risks a formatting slip the frontend can't parse.
 *
 * Available in EVERY context (tenant or masteradmin) via the universal
 * sentinel — this is pure presentation, no module/data access of its own.
 */

const CHART_TYPES = ['pie', 'doughnut', 'bar', 'line'];
const SINGLE_SERIES_TYPES = ['pie', 'doughnut']; // a slice chart only makes sense for one metric at a time

function validate({ type, title, labels, series }) {
  if (!CHART_TYPES.includes(type)) return `type must be one of: ${CHART_TYPES.join(', ')}`;
  if (!title || typeof title !== 'string' || !title.trim()) return 'title is required';
  if (!Array.isArray(labels) || labels.length === 0) return 'labels must be a non-empty array';
  if (!labels.every((l) => typeof l === 'string' && l.trim())) return 'every label must be a non-empty string';
  if (!Array.isArray(series) || series.length === 0) return 'series must be a non-empty array';
  if (SINGLE_SERIES_TYPES.includes(type) && series.length > 1) {
    return `${type} charts only support ONE series (one value per label) — use "bar" or "line" to compare multiple series, or pick a single metric`;
  }
  for (const s of series) {
    if (!Array.isArray(s.values) || s.values.length !== labels.length) {
      return `each series' values array must have exactly ${labels.length} numbers (one per label)`;
    }
    if (!s.values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return 'every value must be a real, finite number — never a guess or placeholder';
    }
  }
  return null;
}

module.exports = [
  {
    name: 'render_chart',
    description:
      'Formats REAL data you already gathered from another tool this turn into a chart the chat UI renders visually (pie, doughnut, bar, or line) — call this whenever the user asks to see data as a chart/graph/pie chart/visualize it, AFTER you already have the real numbers. NEVER invent or estimate values to fill this in. On success, copy the returned replyBlock field VERBATIM into your reply (usually with one short sentence of context before it) — do not retype, reformat, or summarize the JSON yourself.',
    requiredModules: [UNIVERSAL_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CHART_TYPES, description: 'pie/doughnut for one metric split across categories; bar/line for comparing one or more series across the same categories' },
        title: { type: 'string', description: 'Short, human-readable chart title' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Category names, e.g. ["Open","In Progress","Done"]' },
        series: {
          type: 'array',
          description: 'One entry per data series. pie/doughnut must have exactly one.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Series name, e.g. "This month" — omit for a single-series pie/doughnut chart' },
              values: { type: 'array', items: { type: 'number' }, description: 'One real number per label, same order' },
            },
            required: ['values'],
          },
        },
      },
      required: ['type', 'title', 'labels', 'series'],
    },
    async handler(_context, args = {}) {
      const error = validate(args);
      if (error) return { ok: false, error };

      const spec = {
        type: args.type,
        title: args.title.trim(),
        labels: args.labels.map((l) => l.trim()),
        series: args.series.map((s) => ({ label: s.label ? s.label.trim() : null, values: s.values })),
      };
      const replyBlock = '```aida-chart\n' + JSON.stringify(spec) + '\n```';
      return { ok: true, replyBlock };
    },
  },
];
