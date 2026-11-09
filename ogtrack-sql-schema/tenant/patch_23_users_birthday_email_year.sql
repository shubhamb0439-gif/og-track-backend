/* =============================================================================
   PATCH: Users — add last_birthday_email_year column
   =============================================================================
   Run against an existing tenant DB that already has patch_01 applied
   (dbo.users.date_of_birth). Idempotent — safe to re-run.

   Context: guards the daily birthday-announcement email
   (src/birthdayEmailNotifier.js) so a user whose birthday matched today is
   never emailed-about twice in the same calendar year, even if the poller
   runs more than once that day — same convention as the standalone
   Birthday module's own dbo.employee_birthdays.last_greeted_year column.
   ========================================================================== */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users')
      AND name = 'last_birthday_email_year'
)
    ALTER TABLE dbo.users ADD last_birthday_email_year INT NULL;
GO
