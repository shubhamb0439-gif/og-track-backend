/* =============================================================================
   TENANT DATABASE — Part 16: BIRTHDAY
   Provisioned when a company has the 'birthday' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   birthdays
   Each user's saved birthday (month/day, year optional — not everyone wants
   to share their age). One row per user, enforced by a unique index on
   user_id, same pattern as dbo.notes's one-row-per-user note.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.birthdays (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name         NVARCHAR(200)  NULL,
    birth_month       INT            NOT NULL,
    birth_day         INT            NOT NULL,
    birth_year        INT            NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_birthdays_month CHECK (birth_month BETWEEN 1 AND 12),
    CONSTRAINT CK_birthdays_day CHECK (birth_day BETWEEN 1 AND 31),
    CONSTRAINT CK_birthdays_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE UNIQUE INDEX UQ_birthdays_user_id ON dbo.birthdays(user_id);
CREATE INDEX IX_birthdays_month_day ON dbo.birthdays(birth_month, birth_day);
GO

/* ---------------------------------------------------------------------------
   birthday_greetings
   Log of the automatic "Happy Birthday" messages the system has sent. One
   row per user per calendar year — the unique index on (user_id, year) is
   what makes the auto-send job idempotent (safe to check "did we already
   greet this person this year?" and safe to re-run on every poll tick
   without ever sending a duplicate message).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.birthday_greetings (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name         NVARCHAR(200)  NULL,
    message           NVARCHAR(500)  NOT NULL,
    year              INT            NOT NULL,
    sent_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_birthday_greetings_year CHECK (year BETWEEN 2000 AND 2100)
);
GO
CREATE UNIQUE INDEX UQ_birthday_greetings_user_year ON dbo.birthday_greetings(user_id, year);
CREATE INDEX IX_birthday_greetings_sent_at ON dbo.birthday_greetings(sent_at DESC);
GO
