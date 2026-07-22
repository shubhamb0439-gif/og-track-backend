/* =============================================================================
   TENANT DATABASE — Part 1: CORE (always provisioned, regardless of which
   modules a company has enabled — these are needed by every other module).

   Run this against the tenant's own database, e.g.:
       CREATE DATABASE OGTrack_Cajo;
       -- switch connection to OGTrack_Cajo, then run this file.

   Design notes:
   - IDs are kept as NVARCHAR to preserve the original Firestore-style string
     IDs (e.g. 'u1721...', 'PRJ-001') during migration — this avoids having
     to rewrite every foreign-key reference in the existing dataset.
   - Every table that used to receive free-form `{...req.body}` fields from
     the frontend has an `extra_json` NVARCHAR(MAX) column. Known/important
     fields get real typed columns (indexable, queryable); anything else the
     frontend sends lands in extra_json so no data is lost. Application code
     merges extra_json back into the API response object.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   users  (was: Firestore `users` collection)
   Firestore had a flat 'companyId' field for multi-tenant filtering; since
   the tenant DB itself is now the isolation boundary, that column is gone.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.users (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(200)  NOT NULL,
    email           NVARCHAR(320)  NOT NULL UNIQUE,
    password_hash   NVARCHAR(200)  NOT NULL,        -- bcrypt hash; NEVER plaintext (old app stored plaintext — fix on migration)
    role            NVARCHAR(50)   NOT NULL,         -- superadmin | manager | developer | tester | accounts_manager |
                                                      -- senior_accountant | accountant | intern | hr | <custom role name>
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending', -- pending | active | rejected
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_users_status CHECK (status IN ('pending','active','rejected')),
    CONSTRAINT CK_users_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_users_role ON dbo.users(role);
GO

/* Seed superadmin equivalent — mirrors the old auto-seed in server.js.
   Replace the password hash below with a real bcrypt hash before running
   in any environment beyond local dev; this placeholder is NOT a valid hash. */
-- INSERT INTO dbo.users (id, name, email, password_hash, role, status)
-- VALUES ('sa1', 'Super Admin', 'admin@bugtrack.com', '<bcrypt-hash-here>', 'superadmin', 'active');

/* ---------------------------------------------------------------------------
   custom_roles  (was: Firestore `customRoles` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.custom_roles (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(100)  NOT NULL,
    permissions     NVARCHAR(MAX)  NOT NULL DEFAULT '[]',  -- JSON array: ["dashboard","bugs","mybugs",...]
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_custom_roles_permissions_json CHECK (ISJSON(permissions) = 1)
);
GO

/* ---------------------------------------------------------------------------
   id_counters  (was: Firestore `meta` collection, docs like
   'counter_PRJ', 'story_counter_PRJ', 'sub_ticket_counter')
   Generic replacement for every auto-incrementing human-readable ID
   (bug IDs, story IDs, request IDs). Concurrency-safe via the stored
   procedure below (UPDLOCK + HOLDLOCK mirrors Firestore's transaction).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.id_counters (
    counter_key     NVARCHAR(100)  NOT NULL PRIMARY KEY,
    current_value   INT            NOT NULL DEFAULT 0
);
GO

CREATE OR ALTER PROCEDURE dbo.usp_next_counter
    @counter_key NVARCHAR(100),
    @next_value  INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
        -- UPDLOCK+HOLDLOCK: only one concurrent caller can read/bump this row,
        -- exactly matching the atomicity Firestore's runTransaction gave us.
        SELECT @next_value = current_value
        FROM dbo.id_counters WITH (UPDLOCK, HOLDLOCK)
        WHERE counter_key = @counter_key;

        IF @next_value IS NULL
        BEGIN
            SET @next_value = 1;
            INSERT INTO dbo.id_counters (counter_key, current_value) VALUES (@counter_key, 1);
        END
        ELSE
        BEGIN
            SET @next_value = @next_value + 1;
            UPDATE dbo.id_counters SET current_value = @next_value WHERE counter_key = @counter_key;
        END
    COMMIT TRANSACTION;
END
GO
-- Usage from Node (per bug creation), e.g. for project short code 'PRJ':
--   EXEC dbo.usp_next_counter @counter_key = 'counter_PRJ', @next_value = @out OUTPUT;
--   bugId = 'PRJ-' + RIGHT('000' + CAST(@out AS VARCHAR), 3)
