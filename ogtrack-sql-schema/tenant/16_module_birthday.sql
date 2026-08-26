/* =============================================================================
   TENANT DATABASE — Part 16: BIRTHDAY
   Provisioned when a company has the 'birthday' module enabled.
   Requires 01_core_tenant.sql (dbo.users) to have been run first.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   employee_birthdays
   One row per user — the birthday they entered for themselves. month/day are
   stored as their own INT columns (in addition to the full birth_date, which
   keeps the originally-entered year around even though it isn't used for
   the greeting logic) so "who's having a birthday today" can be queried
   with a plain indexed equality check instead of a date-function scan.
   last_greeted_year records the calendar year the automated greeting was
   last sent for, so the same person is never greeted twice in one year even
   if the check runs more than once on their birthday.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.employee_birthdays (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    birth_date        DATE           NOT NULL,
    birth_month       INT            NOT NULL,
    birth_day         INT            NOT NULL,
    last_greeted_year INT            NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_employee_birthdays_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE UNIQUE INDEX UQ_employee_birthdays_user_id ON dbo.employee_birthdays(user_id);
CREATE INDEX IX_employee_birthdays_month_day ON dbo.employee_birthdays(birth_month, birth_day);
GO

/* ---------------------------------------------------------------------------
   birthday_greetings
   A log of every greeting actually sent, so the module has a history to
   show ("greeted on ...") separate from the single last_greeted_year guard
   column above.
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.birthday_greetings (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    greeting_year     INT            NOT NULL,
    message           NVARCHAR(500)  NULL,
    sent_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_birthday_greetings_user_id ON dbo.birthday_greetings(user_id);
CREATE UNIQUE INDEX UQ_birthday_greetings_user_year ON dbo.birthday_greetings(user_id, greeting_year);
GO
