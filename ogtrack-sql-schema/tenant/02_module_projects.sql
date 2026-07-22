/* =============================================================================
   TENANT DATABASE — Part 2: PROJECTS / BUG TRACKER / SPRINTS / STORIES
   Provisioned when a company has any of the 'projects', 'sprints', or 'bugs'
   modules enabled. Requires 01_core_tenant.sql to have been run first
   (references dbo.users, dbo.id_counters).
   ============================================================================= */

/* ---------------------------------------------------------------------------
   projects  (was: Firestore `projects` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.projects (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name            NVARCHAR(300)  NOT NULL,
    short_code      NVARCHAR(20)   NOT NULL UNIQUE,   -- e.g. 'PRJ' — used to prefix bug/story IDs
    description     NVARCHAR(MAX)  NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'active',  -- active | archived
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_projects_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO

/* ---------------------------------------------------------------------------
   bugs  (was: Firestore `bugs` collection)
   id is the human-readable code, e.g. 'PRJ-001' (see id_counters / usp_next_counter)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.bugs (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    project_id        NVARCHAR(64)   NULL REFERENCES dbo.projects(id),  -- NULL/'default' allowed for legacy bugs
    project_name      NVARCHAR(300)  NULL,        -- denormalized for display, matches old projectName field
    title             NVARCHAR(500)  NOT NULL,
    description       NVARCHAR(MAX)  NULL,
    reporter          NVARCHAR(200)  NULL,         -- stores the user's NAME (matches original app logic, not user id)
    assignee          NVARCHAR(200)  NULL,         -- stores the user's NAME
    status            NVARCHAR(30)   NOT NULL DEFAULT 'Open',
                       -- Open | Fixed | Resolved | Closed | Won't Fix | Wont Fix | Not a Bug | Expected Behavior | NAB
    fix_summary       NVARCHAR(MAX)  NULL DEFAULT '',
    further_changes   NVARCHAR(MAX)  NOT NULL DEFAULT '[]',  -- JSON array of dev change-notes
    audit_trail       NVARCHAR(MAX)  NOT NULL DEFAULT '[]',  -- JSON array of {who, action, when, note}
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    resolved_at       DATETIME2      NULL,
    retested_at       DATETIME2      NULL,
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_bugs_further_changes_json CHECK (ISJSON(further_changes) = 1),
    CONSTRAINT CK_bugs_audit_trail_json CHECK (ISJSON(audit_trail) = 1),
    CONSTRAINT CK_bugs_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_bugs_project_id ON dbo.bugs(project_id);
CREATE INDEX IX_bugs_status ON dbo.bugs(status);
CREATE INDEX IX_bugs_created_at ON dbo.bugs(created_at DESC);
GO

/* ---------------------------------------------------------------------------
   sprints  (was: Firestore `sprints` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.sprints (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    project_id      NVARCHAR(64)   NOT NULL REFERENCES dbo.projects(id),
    name            NVARCHAR(300)  NOT NULL,
    start_date      DATE           NULL,
    end_date        DATE           NULL,
    status          NVARCHAR(20)   NOT NULL DEFAULT 'planned',  -- planned | active | completed
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_sprints_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_sprints_project_id ON dbo.sprints(project_id);
GO

/* ---------------------------------------------------------------------------
   stories  (was: Firestore `stories` collection)
   story_id is the human-readable code, e.g. 'PRJ-S001'
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.stories (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    story_id        NVARCHAR(30)   NOT NULL UNIQUE,
    project_id      NVARCHAR(64)   NULL REFERENCES dbo.projects(id),
    sprint_id       NVARCHAR(64)   NULL REFERENCES dbo.sprints(id),
    title           NVARCHAR(500)  NOT NULL,
    description     NVARCHAR(MAX)  NULL,
    status          NVARCHAR(30)   NOT NULL DEFAULT 'backlog',
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NULL,
    extra_json      NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_stories_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_stories_project_id ON dbo.stories(project_id);
GO
