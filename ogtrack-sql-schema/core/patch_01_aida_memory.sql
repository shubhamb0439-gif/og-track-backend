/* =============================================================================
   PATCH: aida_memories — AIDA's long-term memory (master admin only)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same "additive patch to
   an already-provisioned DB, run once by hand" convention as the tenant-side
   patch_*.sql files (see ogtrack-sql-schema/tenant/patch_01_...). Idempotent
   — safe to re-run.

   Context: distilled, durable facts AIDA has learned from master-admin
   conversations (preferences, standing corrections, project context) — NOT
   raw chat transcripts (those stay in sessionMemory.js, in-RAM, short-lived).
   Scoped globally to the master admin identity, not per company/tenant —
   see src/aida/memory.js.
   ============================================================================= */

IF OBJECT_ID('dbo.aida_memories', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.aida_memories (
        id           NVARCHAR(64)   NOT NULL PRIMARY KEY,
        category     NVARCHAR(30)   NOT NULL,   -- 'user' | 'feedback' | 'project' | 'reference' — same taxonomy AIDA itself is briefed on
        content      NVARCHAR(MAX)  NOT NULL,
        created_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_aida_memories_category CHECK (category IN ('user','feedback','project','reference'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_aida_memories_created_at' AND object_id = OBJECT_ID('dbo.aida_memories'))
    CREATE INDEX IX_aida_memories_created_at ON dbo.aida_memories(created_at);
GO
