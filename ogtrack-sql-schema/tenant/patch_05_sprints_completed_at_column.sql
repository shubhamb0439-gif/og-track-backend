/* =============================================================================
   PATCH: Sprints — add missing completed_at column
   =============================================================================
   Run against an existing tenant DB that already has 02_module_projects.sql
   applied. Idempotent — safe to re-run.

   Context: the "Mark Complete" action on a sprint (frontend index.html,
   completeSprint()) sends PATCH /api/:slug/sprints/:id with
   { status: 'completed', completedAt: <ISO timestamp> }. src/routes/sprints.js
   passed completedAt straight through into the UPDATE statement, but
   dbo.sprints never had a completed_at (or completedAt) column, so the query
   failed with "Invalid column name 'completedAt'" and the sprint was never
   marked complete. Named completed_at, not completedAt, to match this
   table's existing snake_case convention (created_at, updated_at).
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.sprints')
      AND name = 'completed_at'
)
    ALTER TABLE dbo.sprints ADD completed_at DATETIME2 NULL;
GO
