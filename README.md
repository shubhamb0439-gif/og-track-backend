# OGTrack Backend v2 — Azure SQL, multi-tenant (DB-per-company)

The rewritten backend. Replaces Firestore with Azure SQL, splits every request
onto the correct tenant database via the URL slug, and keeps real-time events
isolated per tenant.

## Structure

```
src/
  config.js                     env loader (throws early if a required var is missing)
  db/
    core.js                     single fixed Knex connection to OGCore
    tenantConnections.js        slug -> company row -> cached per-tenant Knex connection
  middleware/
    resolveTenant.js            attaches req.db + req.company for /api/:slug/* routes
    requireModule.js            403s if the tenant hasn't enabled that module
  utils/
    counters.js                 row-locked counter (replaces Firestore transaction counters)
    auth.js                     bcrypt hashing + JWT (replaces plaintext passwords)
  routes/
    companies.js                masteradmin — operates on OGCore only
    users.js  projects.js  bugs.js  sprints.js  stories.js
    sub_tickets.js  roles.js  attendance.js       tenant-scoped
  server.js                     wires it all together + Socket.io per-tenant rooms
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your real Azure SQL values:
   - `AZURE_SQL_SERVER` — your logical server host, e.g. `ogtrack-sqlsrv-prod.database.windows.net`
   - `AZURE_SQL_USER` / `AZURE_SQL_PASSWORD` — the admin login you use in Azure Data Studio
   - `JWT_SECRET` — any long random string
   - Leave `AZURE_SQL_CORE_DB=OGCore`
3. Make sure the Azure SQL server firewall allows your machine's IP (same rule that let Azure Data Studio connect).
4. `npm start`  → should print `OGTrack backend listening on :3000`

## Smoke test — is it alive?

```
curl http://localhost:3000/health
# {"status":"ok","core":"connected"}   <- confirms it reached OGCore
```

If `core` shows an error instead, it's the same class of issue as the Azure Data
Studio connection errors: wrong server host, firewall, or credentials.

## The important test — prove tenant isolation

These two calls hit the SAME code but land in DIFFERENT databases purely because
of the slug (`ogtrack` vs `cajo`):

```
# Register a user into OGTrack's database
curl -X POST http://localhost:3000/api/ogtrack/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@ogtrack.test","password":"Test@1234","role":"tester"}'

# Register a user into Cajo's database
curl -X POST http://localhost:3000/api/cajo/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@cajo.test","password":"Test@1234","role":"tester"}'
```

Then confirm each user only exists in its own tenant by checking the databases in
Azure Data Studio:

```sql
-- against ogtrack-db-prod:  should show Alice, NOT Bob
SELECT name, email, role, status FROM dbo.users;

-- against OGtrack_cajo:     should show Bob, NOT Alice
SELECT name, email, role, status FROM dbo.users;
```

New users come in as `status='pending'` (same as the old app). To activate one so
you can log in, either flip it in SQL:
```sql
UPDATE dbo.users SET status='active' WHERE email='alice@ogtrack.test';
```
...or once you have an active superadmin, via `PATCH /api/ogtrack/users/:id/status`.

## The module-gating test

Cajo has the attendance module; OGTrack does not. Same endpoint, different result:

```
# Works (Cajo has attendance):
curl -X POST http://localhost:3000/api/cajo/attendance/clockin \
  -H "Content-Type: application/json" -d '{"userId":"<a real cajo user id>","userName":"Bob"}'

# 403 (OGTrack does NOT have attendance):
curl -X POST http://localhost:3000/api/ogtrack/attendance/clockin \
  -H "Content-Type: application/json" -d '{"userId":"x","userName":"y"}'
# {"error":"Module \"attendance\" is not enabled for this company.","module":"attendance"}
```

That 403 is the whole multi-tenant module system working: one codebase, per-tenant
behavior driven entirely by the `enabled_modules` column in OGCore.

## What changed vs the old server.js (important)

- **Login now returns a JWT** (`{ token, user }`) instead of just the user object.
  The frontend will need to store that token and send it as `Authorization: Bearer <token>`
  — we handle this in the frontend-split phase.
- **Passwords are bcrypt-hashed.** The old plaintext accounts from Firestore can't be
  carried over as-is; existing users need a fresh registration or a password reset
  (covered in the data-migration step). The old auto-seeded `admin@bugtrack.com` is
  NOT auto-created here — we'll seed a proper hashed superadmin during migration.
- **No `companyId` filtering anywhere** — the database connection is the tenant boundary.

## Endpoint map (all built)

Tenant-scoped, all under `/api/:slug/...`:
- `users` (register/login/status/role), `projects`, `bugs`, `sprints`, `stories`,
  `sub-tickets`, `roles`
- `attendance/*` (clockin/out, regularize, leave) — gated by the attendance module
- `conversations/*` (messaging) — gated by the messages module
- `acc/clients`, `acc/time-entries`, `acc/eod-reports`, `acc/eod-routes` — gated by acc_clients
- `hr/jobs`, `hr/candidates`, `hr/interviews` — gated by hr_jobs

Platform-scoped (OGCore, masteradmin): `/api/companies`

Note the `acc/` and `hr/` path prefixes — accounting and HR endpoints live under
those namespaces (e.g. `POST /api/ogtrack/hr/jobs`, `GET /api/ogtrack/acc/clients`)
so their module gate doesn't interfere with sibling routes.

## Not built yet (next phases)

- Automated provisioning (so masteradmin "create company" runs the CREATE DATABASE +
  schema scripts + OGCore insert automatically instead of by hand)
- File upload endpoint (needs an Azure Blob Storage decision vs the old local-disk approach)
- Frontend split
- Data migration from the old Firestore export (optional, if you want existing data carried over)
