# AIDA VPS coding-agent (roadmap item 20)

Standalone service — NOT part of ogtrack-backend's own `npm install`/Azure deploy. Deployed
manually as its own Docker container on the Hostinger VPS, alongside vps-bridge (item 17) and
the other apps already running there.

Runs the **real Claude Code CLI**, headlessly, against the exact same sandbox directory
vps-bridge already `git clone`d for a `dev_repo_fix` job — in place of ogtrack-backend's own
hand-rolled Anthropic tool-use loop. This container never clones/commits/pushes anything
itself; it only reads/writes inside a sandbox vps-bridge already created, via a Docker volume
**shared between both containers**.

## 1. Generate the shared secret

`openssl rand -hex 32` — becomes `VPS_CODING_AGENT_SECRET`. Deliberately a **different** secret
from `VPS_BRIDGE_SECRET`, even though both run on the same VPS.

## 2. Decide how this container authenticates to Anthropic

Two options — pick ONE per container (see the conversation that led to this build for the full
tradeoff discussion):

**Option A — API key (recommended for production use):** pass `ANTHROPIC_API_KEY` as a plain
`-e` env var in step 3's `docker run` below. No login step needed at all — the CLI detects the
key and skips authentication entirely.

**Option B — your Claude subscription:** skip the `-e ANTHROPIC_API_KEY=...` line below, and
instead run a ONE-TIME interactive login after the container exists:
```bash
docker run -it --rm -v aida-vps-coding-agent-claude-config:/root/.claude aida-vps-coding-agent claude
```
This prints a login URL — open it on your own phone/laptop browser, sign in, approve. Exit with
`/exit` once it confirms login. The session is saved in the `aida-vps-coding-agent-claude-config`
volume, which the real long-running container (step 3) also mounts, so it's reused automatically
from then on. **Known risk, not a blocker**: Anthropic has signaled this kind of scripted/headless
usage may eventually stop counting under a subscription plan — if that ever happens, or the login
session expires, every VPS-backed job will start failing with a clear error until Option A is
switched to (just re-run step 3 with `-e ANTHROPIC_API_KEY=...` added — no code change needed on
either side).

## 3. Build and run on the VPS

```bash
cd vps-coding-agent
docker build -t aida-vps-coding-agent .
docker run -d \
  --name aida-vps-coding-agent \
  --restart unless-stopped \
  -e VPS_CODING_AGENT_SECRET="<the secret from step 1>" \
  -e ANTHROPIC_API_KEY="<only if using Option A above — omit entirely for Option B>" \
  -v aida-vps-bridge-sandboxes:/sandboxes \
  -v aida-vps-coding-agent-claude-config:/root/.claude \
  aida-vps-coding-agent
```

**`-v aida-vps-bridge-sandboxes:/sandboxes` must name the EXACT SAME volume vps-bridge itself
uses** (see `vps-bridge/README.md` step 2) — this is what lets this container see the sandbox
directory vps-bridge already cloned. A typo here (a new/different volume name) would make every
job fail with a 404 "no sandbox directory" error, since this container would be looking at an
empty volume instead of the real one.

Confirm it's alive:
```bash
docker exec aida-vps-coding-agent wget -qO- http://localhost:3200/health
# -> {"ok":true}
```

## 4. Route it through the existing Traefik, on its own subdomain

Same process as `vps-bridge/README.md` step 3 — inspect the existing Traefik setup first, add
this container to the same Docker network, give it a matching label/route for a new subdomain
(e.g. `vps-coding-agent.<existing base domain>`) targeting port 3200, add the DNS A record.

A real coding task can run for several minutes — make sure Traefik's own forwarding/idle timeout
is raised well past `CODING_AGENT_TIMEOUT_MS` (default 1,200,000ms / 20 minutes) for specifically
this route, or a slow run will hit a confusing 504 instead of this service's own clean
`{success:false}` result.

## 5. Point Azure at it

Add to Azure App Service's own Configuration (Application settings) — **only after** `VPS_BRIDGE_SECRET`/
`VPS_BRIDGE_BASE_URL` are already set and working (this service is useless without a VPS-backed
sandbox to point it at):
- `VPS_CODING_AGENT_SECRET` — the exact same value from step 1.
- `VPS_CODING_AGENT_BASE_URL` — `https://vps-coding-agent.<your subdomain>` (no trailing slash).

Once both are set, `config.aida.vpsCodingAgent.enabled` flips to `true` automatically, and every
VPS-backed `dev_repo_fix` job (i.e. `vpsBridge` also enabled, and not an `actionFastLane` job)
routes its actual coding work here instead of the local hand-rolled loop.

## Tuning

- `CODING_AGENT_MODEL` (default `claude-sonnet-5-5`) — pinned deliberately; without an explicit
  `--model` flag, live testing showed the CLI defaults to Opus 5.5, meaningfully pricier/slower
  for routine coding-fix tasks.
- `CODING_AGENT_TIMEOUT_MS` (default `1200000` / 20 minutes) — how long one `claude -p` run may
  take before this service gives up and returns a clean failure instead of hanging a job forever.

## Updating later

```bash
cd vps-coding-agent
docker build -t aida-vps-coding-agent .
docker stop aida-vps-coding-agent && docker rm aida-vps-coding-agent
# re-run the same `docker run` command from step 3
```
