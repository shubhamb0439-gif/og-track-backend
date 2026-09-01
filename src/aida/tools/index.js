const { registerTools } = require('../toolRegistry');

/**
 * The one place that wires every tool file into the registry. Adding a new
 * module's tools later is: write src/aida/tools/<module>.js exporting an
 * array of tool defs, require it here, add it to this list. Nothing in
 * engine.js, toolRegistry.js, or the routes needs to change.
 */
const MODULE_TOOL_FILES = [
  require('./attendance'),
  require('./projects'),
  require('./crm'),
  require('./inventory'),
  require('./finance'),
  require('./hr'),
  require('./masteradmin'),
  require('./masteradminCrossTenant'),
  require('./devops'),
  require('./webResearch'),
];

let registered = false;

function registerAllTools() {
  if (registered) return; // registerTool throws on duplicate names — guard against double require in tests/hot-reload
  MODULE_TOOL_FILES.forEach(registerTools);
  registered = true;
}

module.exports = { registerAllTools };
