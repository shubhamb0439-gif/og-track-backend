/* =============================================================================
   TENANT DATABASE — Part 13: SUPER ADMIN TODO LIST
   Provisioned when a company has the 'super_admin_todo_list' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   super_admin_todos
   Simple personal/superadmin task list shown in a dedicated left-hand
   sidebar section. id is an app-generated string key (not a human-readable
   counter code like bugs/tickets — this module has no per-project numbering).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.super_admin_todos (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    title           NVARCHAR(500)  NOT NULL,
    notes           NVARCHAR(MAX)  NULL,
    is_completed    BIT            NOT NULL DEFAULT 0,
    created_by      NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    completed_at    DATETIME2      NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_super_admin_todos_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_super_admin_todos_is_completed ON dbo.super_admin_todos(is_completed);
CREATE INDEX IX_super_admin_todos_created_at ON dbo.super_admin_todos(created_at DESC);
GO
