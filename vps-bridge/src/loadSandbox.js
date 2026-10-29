const sandboxStore = require('./sandboxStore');

/** Resolves `req.params.id` to a real sandbox entry via the in-memory store — the ONLY path from a client-supplied id to a real directory on this host. 404s rather than guessing if it's unknown (already cleaned up, or never existed). */
function loadSandbox(req, res, next) {
  const entry = sandboxStore.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: `No sandbox with id "${req.params.id}" (already cleaned up, or never existed).` });
  }
  req.sandbox = entry;
  next();
}

module.exports = { loadSandbox };
