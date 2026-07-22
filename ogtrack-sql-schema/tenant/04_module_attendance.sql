/* =============================================================================
   TENANT DATABASE — Part 4: ATTENDANCE / REGULARIZATION / LEAVE
   Provisioned when 'attendance' (and/or 'history') module is enabled.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   attendance  (was: Firestore `attendance` collection, doc id `${userId}_${date}`)
   Kept the composite id as a literal PK string ('userId_date') to preserve
   the exact same "one row per user per day, upsert on clock-in/out" logic
   the old app relied on (Firestore .set({merge:true})).
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.attendance (
    id              NVARCHAR(150)  NOT NULL PRIMARY KEY,   -- '{user_id}_{date}'
    user_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name       NVARCHAR(200)  NULL,
    date            DATE           NOT NULL,
    clock_in        DATETIME2      NULL,
    clock_out       DATETIME2      NULL,
    total_hours     DECIMAL(5,2)   NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'present',  -- present | regularized
    auto_clockout   BIT            NOT NULL DEFAULT 0,          -- set by the 22:00 auto clock-out job
    CONSTRAINT UQ_attendance_user_date UNIQUE (user_id, date)
);
GO
CREATE INDEX IX_attendance_date ON dbo.attendance(date DESC);
GO

/* ---------------------------------------------------------------------------
   regularize_requests  (was: Firestore `regularizeRequests` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.regularize_requests (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name       NVARCHAR(200)  NULL,
    date            DATE           NOT NULL,
    reason          NVARCHAR(MAX)  NULL,
    requested_in    DATETIME2      NULL,
    requested_out   DATETIME2      NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    approved_by     NVARCHAR(200)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    resolved_at     DATETIME2      NULL
);
GO
CREATE INDEX IX_regularize_requests_user ON dbo.regularize_requests(user_id);
GO

/* ---------------------------------------------------------------------------
   leave_requests  (was: Firestore `leaveRequests` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.leave_requests (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    user_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name       NVARCHAR(200)  NULL,
    from_date       DATE           NOT NULL,
    to_date         DATE           NOT NULL,
    reason          NVARCHAR(MAX)  NULL,
    leave_type      NVARCHAR(30)   NOT NULL DEFAULT 'Casual',
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    approved_by     NVARCHAR(200)  NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    resolved_at     DATETIME2      NULL
);
GO
CREATE INDEX IX_leave_requests_user ON dbo.leave_requests(user_id);
GO
