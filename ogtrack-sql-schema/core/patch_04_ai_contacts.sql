/* =============================================================================
   PATCH: ai_contacts — AIDA roadmap item 8.3 (remember a contact's email by name)
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_01_aida_memory.sql / patch_02_ai_email_monitor_state.sql. Idempotent.

   Context: a structured name->email lookup AIDA code queries directly —
   deliberately separate from aida_memories (patch_01), which is free-text
   prose meant as LLM context, not something application code parses back
   apart. Master-admin scoped, not per-company.
   ============================================================================= */

IF OBJECT_ID('dbo.ai_contacts', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ai_contacts (
        id           NVARCHAR(40)   NOT NULL PRIMARY KEY,
        name         NVARCHAR(200)  NOT NULL,
        email        NVARCHAR(200)  NOT NULL,
        created_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at   DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO
