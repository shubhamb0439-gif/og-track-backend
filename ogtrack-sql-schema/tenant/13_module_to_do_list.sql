/* =============================================================================
   TENANT DATABASE — Part 13: TO-DO LIST
   Provisioned when a company has the 'to_do_list' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   todo_items
   Simple personal/team to-do list. Items can optionally be assigned to a
   user; unassigned items are visible to everyone (used by the "section on
   existing page" widget as well as the dedicated management page).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.todo_items (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    title             NVARCHAR(500)  NOT NULL,
    description       NVARCHAR(MAX)  NULL,
    status            NVARCHAR(20)   NOT NULL DEFAULT 'pending',
                       -- pending | in_progress | done
    priority          NVARCHAR(20)   NOT NULL DEFAULT 'normal',
                       -- low | normal | high
    due_date          DATE           NULL,
    assigned_to       NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    assigned_to_name  NVARCHAR(200)  NULL,
    created_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_by_name   NVARCHAR(200)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    completed_at      DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_todo_items_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_todo_items_status ON dbo.todo_items(status);
CREATE INDEX IX_todo_items_assigned_to ON dbo.todo_items(assigned_to);
CREATE INDEX IX_todo_items_created_at ON dbo.todo_items(created_at DESC);
GO
