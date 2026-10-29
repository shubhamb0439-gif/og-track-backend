# AIDA VPS execution bridge (roadmap item 17)

Standalone service — NOT part of ogtrack-backend's own `npm install`/Azure deploy. Deployed
manually as its own Docker container on the Hostinger VPS, alongside the 7 apps already running
there (bolt.diy, hermes-agent, hermes-workspace, agent-zero, openclaw, paperclip, traefik).

Relocates ONLY the coding agent's sandbox **execution** (file I/O, `npm install`/`test`, git
commit/push) off Azure App Service onto this VPS, for `dev_repo_fix` jobs. The decision-making
brain (Anthropic/OpenAI calls, job orchestration, approval gates) stays on Azure, unchanged.

## 1. Generate the shared secret

Run locally (or anywhere): `openssl rand -hex 32` — this becomes `VPS_BRIDGE_SECRET`, used on
**both** sides (this container, and Azure App Service's own app settings). Never reuse a secret
from another integration.

## 2. Build and run on the VPS

```bash
# copy this vps-bridge/ folder onto the VPS (e.g. git clone the whole repo there, or scp just this folder)
cd vps-bridge
docker build -t aida-vps-bridge .
docker run -d \
  --name aida-vps-bridge \
  --restart unless-stopped \
  -e VPS_BRIDGE_SECRET="<the secret from step 1>" \
  -v aida-vps-bridge-sandboxes:/sandboxes \
  aida-vps-bridge
```

Confirm it's alive:
```bash
docker exec aida-vps-bridge wget -qO- http://localhost:3100/health
# -> {"ok":true,"sandboxes":0}
```

## 3. Route it through the existing Traefik, on a new subdomain

**Inspect the existing setup first — don't guess at label syntax.**
```bash
docker inspect <bolt.diy's container name> --format '{{json .Config.Labels}}'
docker inspect traefik-gknf-traefik-1 --format '{{json .Config.Labels}}'
docker inspect traefik-gknf-traefik-1 --format '{{json .Mounts}}'
```
This reveals whether routing is Docker-label-based or file-provider-based, and whether a
Let's-Encrypt resolver is already configured globally. Add the bridge's own container to the
same Docker network as Traefik, give it a matching label/route for a new subdomain (e.g.
`vps-bridge.<existing base domain>`) targeting port 3100, and add the DNS A record for that
subdomain pointing at this VPS's IP.

Also check Traefik's own forwarding/idle timeout isn't shorter than ~200s — a too-short timeout
would turn a slow `npm install`/`npm test` into a confusing 504 instead of a clean
`timedOut:true` result from the bridge itself.

Verify the firewall allows 80/443 externally (same drop-all-by-default surprise that blocked SSH
initially may apply here too — check the Hostinger panel's Firewall rules).

## 4. Point Azure at it

Add to Azure App Service's own Configuration (Application settings):
- `VPS_BRIDGE_SECRET` — the exact same value from step 1.
- `VPS_BRIDGE_BASE_URL` — `https://vps-bridge.<your subdomain>` (no trailing slash).

Once both are set, `config.aida.vpsBridge.enabled` flips to `true` automatically, and every new
`dev_repo_fix` job (except ones with `actionFastLane: true`) routes its sandbox execution here.

## Updating the bridge later

```bash
cd vps-bridge
docker build -t aida-vps-bridge .
docker stop aida-vps-bridge && docker rm aida-vps-bridge
# re-run the same `docker run` command from step 2
```
