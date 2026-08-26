/* =============================================================================
   TENANT DATABASE — Part 16: BIRTHDAY MODULE
   Provisioned when a company has the 'birthday_module' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   birthday_profiles
   Each user's birth date, entered once and editable afterward. One row per
   user (enforced by a unique index on user_id), used to figure out who to
   send a birthday greeting to each day.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.birthday_profiles (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name         NVARCHAR(200)  NULL,
    birth_date        DATE           NOT NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_birthday_profiles_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE UNIQUE INDEX UQ_birthday_profiles_user_id ON dbo.birthday_profiles(user_id);
GO

/* ---------------------------------------------------------------------------
   birthday_greetings
   Log of birthday greetings the system has sent. One row per user per
   calendar year (enforced by the unique constraint below), so re-checking
   "is it someone's birthday today" repeatedly never sends duplicates.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.birthday_greetings (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name         NVARCHAR(200)  NULL,
    greeting_year     INT            NOT NULL,
    message           NVARCHAR(500)  NOT NULL,
    sent_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_birthday_greetings_user_year UNIQUE (user_id, greeting_year)
);
GO
CREATE INDEX IX_birthday_greetings_sent_at ON dbo.birthday_greetings(sent_at DESC);
GO
