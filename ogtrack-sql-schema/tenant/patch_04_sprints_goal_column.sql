/* =============================================================================
   PATCH: Sprints — add missing goal column
   =============================================================================
   Run against an existing tenant DB that already has 02_module_projects.sql
   applied. Idempotent — safe to re-run.

   Context: src/routes/sprints.js has always read/written a `goal` field on
   sprints, but dbo.sprints never had that column. Every sprint-create INSERT
   referenced the non-existent column and failed with "Invalid column name
   'goal'", so the sprint was never persisted — it only appeared in the UI
   from the optimistic local state, then vanished on reload.
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.sprints')
      AND name = 'goal'
)
    ALTER TABLE dbo.sprints ADD goal NVARCHAR(MAX) NULL;
GO
