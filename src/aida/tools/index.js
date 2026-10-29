const { registerTools } = require('../toolRegistry');

/**
 * The one place that wires every tool file into the registry. Adding a new
 * module's tools later is: write src/aida/tools/<module>.js exporting an
 * array of tool defs, require it here, add it to this list with a
 * `category` (the file-level default — see toolRegistry.js's registerTools;
 * an individual tool can still set its own `category`/`subcategory` to
 * override this, used for files whose tools span more than one real
 * domain). Nothing in engine.js, toolRegistry.js, or the routes needs to
 * change.
 *
 * Genuinely new, AI-built tools (see capabilityGapProposal.js) land in
 * src/aida/tools/actions/<name>.js instead — see that folder's README.md.
 * Registering one here is the same one-line add as any other tool file;
 * omit `category` (defaults to "Custom Actions") unless the new tool sets
 * its own.
 *
 * masteradminCrossTenant.js is the one exception — it's not a single
 * business domain (it wraps all 7 tenant-tool files), so it sets a real
 * `category`/`subcategory` per-tool itself (see that file); no default is
 * passed for it here.
 */
const MODULE_TOOL_FILES = [
  { tools: require('./attendance'), category: 'Attendance' },
  { tools: require('./projects'), category: 'Projects' },
  { tools: require('./crm'), category: 'CRM' },
  { tools: require('./inventory'), category: 'Inventory' },
  { tools: require('./finance'), category: 'Finance' },
  { tools: require('./hr'), category: 'HR' },
  { tools: require('./sitara'), category: 'Sitara Drapes' },
  { tools: require('./masteradmin'), category: 'Other' },
  { tools: require('./masteradminCrossTenant') },
  { tools: require('./devops'), category: 'Developer Tools' },
  { tools: require('./webResearch'), category: 'Web Research' },
  { tools: require('./dataViz'), category: 'Data Visualization' },
  { tools: require('./actions/makePdf') },
  { tools: require('./actions/compareDatasets') },
];

let registered = false;

function registerAllTools() {
  if (registered) return; // registerTool throws on duplicate names — guard against double require in tests/hot-reload
  MODULE_TOOL_FILES.forEach(({ tools, category }) => registerTools(tools, { category }));
  registered = true;
}

module.exports = { registerAllTools };
