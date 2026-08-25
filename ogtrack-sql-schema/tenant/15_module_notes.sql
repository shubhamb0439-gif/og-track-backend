/* =============================================================================
   TENANT DATABASE — Part 15: NOTES
   Provisioned when a company has the 'notes' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   notes
   Private per-user scratchpad. Each user has exactly one note document that
   they write into and save — not a shared/team note, never visible to other
   users. Enforced by a unique index on user_id plus the route only ever
   reading/writing the row that matches the requesting user's id.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.notes (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    content           NVARCHAR(MAX)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_notes_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE UNIQUE INDEX UQ_notes_user_id ON dbo.notes(user_id);
GO
