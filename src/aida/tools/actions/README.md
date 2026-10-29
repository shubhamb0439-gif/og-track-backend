# src/aida/tools/actions/

Home for genuinely new, AI-built tools (AIDA roadmap item 16, part 2) — created by the
`capability_gap_proposal` job kind's build step, not written by hand.

Existing tool files (`attendance.js`, `crm.js`, etc.) are **not** migrated here — this folder is
only for tools that didn't exist before and were built by AIDA itself.

Each file in this folder follows the exact same contract as every other file in `src/aida/tools/`:

```js
module.exports = [
  {
    name: 'some_new_action',
    description: '...',
    requiredModules: [], // or [MASTERADMIN_SENTINEL_MODULE] / [UNIVERSAL_SENTINEL_MODULE] — see contextBuilder.js
    category: 'Custom Actions', // optional — omit to default to "Custom Actions"; set a more specific one if this clearly belongs with an existing group (e.g. 'Accounting')
    inputSchema: { type: 'object', properties: { ... }, required: [...] },
    handler: async (args, context) => { ... },
  },
];
```

A new file here must be registered with exactly one new `require(...)` line added to
`src/aida/tools/index.js`'s `MODULE_TOOL_FILES` array — nothing else. This narrow, mechanically-
checkable shape (one new file here + one additive line in `index.js`, with `npm test` passing) is
what lets `devFix.js` auto-merge the PR immediately instead of waiting for human approval. Any
change outside that shape falls back to the normal approval flow automatically.
