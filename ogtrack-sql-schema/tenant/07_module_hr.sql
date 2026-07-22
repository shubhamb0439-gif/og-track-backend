/* =============================================================================
   TENANT DATABASE — Part 7: HR / RECRUITING
   Provisioned when any of 'hr_dashboard', 'hr_jobs', 'hr_candidates',
   'hr_interviews' are enabled.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   jobs  (was: Firestore `jobs` collection)
   job_id is the human-readable code, e.g. 'JOB-001'
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.jobs (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    job_id            NVARCHAR(20)   NOT NULL UNIQUE,
    title             NVARCHAR(300)  NOT NULL,
    department        NVARCHAR(150)  NULL,
    employment_type   NVARCHAR(50)   NULL,     -- Full-time | Part-time | Contract ...
    location          NVARCHAR(200)  NULL,
    work_mode         NVARCHAR(30)   NULL,     -- Remote | Hybrid | On-site
    experience        NVARCHAR(50)   NULL,     -- free text, e.g. '3-5 years'
    vacancies         INT            NOT NULL DEFAULT 1,
    description       NVARCHAR(MAX)  NULL,
    salary_range      NVARCHAR(100)  NULL,
    qualification     NVARCHAR(200)  NULL,
    skills            NVARCHAR(MAX)  NULL,      -- JSON array of required skill strings
    status            NVARCHAR(20)   NOT NULL DEFAULT 'draft',  -- draft | published | closed
    applications      INT            NOT NULL DEFAULT 0,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_jobs_skills_json CHECK (skills IS NULL OR ISJSON(skills) = 1),
    CONSTRAINT CK_jobs_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_jobs_status ON dbo.jobs(status);
GO

/* ---------------------------------------------------------------------------
   candidates  (was: Firestore `candidates` collection)
   candidate_id is the human-readable code, e.g. 'CAND-0001'
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.candidates (
    id                  NVARCHAR(64)   NOT NULL PRIMARY KEY,
    candidate_id        NVARCHAR(20)   NOT NULL UNIQUE,
    job_id              NVARCHAR(64)   NULL REFERENCES dbo.jobs(id),
    name                NVARCHAR(200)  NULL,
    email               NVARCHAR(320)  NULL,
    phone               NVARCHAR(30)   NULL,
    resume_url          NVARCHAR(500)  NULL,
    cover_letter        NVARCHAR(MAX)  NULL,
    skills              NVARCHAR(MAX)  NULL,       -- free-text or JSON, matches old loosely-typed field
    experience_summary  NVARCHAR(MAX)  NULL,
    education           NVARCHAR(300)  NULL,
    experience_years    DECIMAL(4,1)   NULL,
    status              NVARCHAR(30)   NOT NULL DEFAULT 'applied',
                         -- applied | ai_screened | shortlisted | interview | offered | rejected | hired
    ai_score            INT            NULL,
    ai_analysis         NVARCHAR(MAX)  NULL,       -- JSON: {score, skillScore, expScore, eduScore, jdScore, matchedSkills, ...}
    status_history      NVARCHAR(MAX)  NOT NULL DEFAULT '[]',  -- JSON array of {status, timestamp, by}
    applied_at          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2      NULL,
    extra_json          NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_candidates_ai_analysis_json CHECK (ai_analysis IS NULL OR ISJSON(ai_analysis) = 1),
    CONSTRAINT CK_candidates_status_history_json CHECK (ISJSON(status_history) = 1),
    CONSTRAINT CK_candidates_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_candidates_job_id ON dbo.candidates(job_id);
CREATE INDEX IX_candidates_status ON dbo.candidates(status);
GO

/* ---------------------------------------------------------------------------
   interviews  (was: Firestore `interviews` collection)
   interview_id is the human-readable code, e.g. 'INT-0001'
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.interviews (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    interview_id      NVARCHAR(20)   NOT NULL UNIQUE,
    candidate_id      NVARCHAR(64)   NOT NULL REFERENCES dbo.candidates(id),
    job_id            NVARCHAR(64)   NULL REFERENCES dbo.jobs(id),
    scheduled_at      DATETIME2      NULL,
    interviewer       NVARCHAR(200)  NULL,
    mode              NVARCHAR(30)   NULL,     -- Onsite | Video | Phone
    status            NVARCHAR(30)   NOT NULL DEFAULT 'scheduled',  -- scheduled | completed | cancelled | rescheduled
    feedback          NVARCHAR(MAX)  NULL,
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NULL,
    extra_json        NVARCHAR(MAX)  NULL,
    CONSTRAINT CK_interviews_extra_json CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1)
);
GO
CREATE INDEX IX_interviews_candidate ON dbo.interviews(candidate_id);
CREATE INDEX IX_interviews_scheduled_at ON dbo.interviews(scheduled_at DESC);
GO
