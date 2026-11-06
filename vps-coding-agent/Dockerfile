FROM node:22-alpine

# The real Claude Code CLI — this is the whole point of this service: a more
# capable, battle-tested agent engine running against the exact same sandbox
# vps-bridge already cloned, instead of ogtrack-backend's own hand-rolled
# Anthropic tool-use loop.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Deliberately runs as root (no USER directive, unlike vps-bridge's
# non-root 'bridge' user): this service needs full read/write access to
# sandbox directories regardless of which UID vps-bridge's own container
# created them as (they're two separate containers with separate user
# namespaces sharing one Docker volume), and root's home (/root) is exactly
# where a mounted subscription-login volume (-v ...:/root/.claude) already
# verified working in manual testing expects to find it.
ENV SANDBOX_ROOT=/sandboxes
ENV PORT=3200
# How long one `claude -p` run may take before this service gives up on it
# and returns a clean {success:false} result instead of hanging forever —
# generous relative to a real multi-file fix, bounded so a stuck CLI process
# can't block a job indefinitely.
ENV CODING_AGENT_TIMEOUT_MS=1200000

EXPOSE 3200

CMD ["node", "src/server.js"]
