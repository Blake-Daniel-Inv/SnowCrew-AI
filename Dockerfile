# ============================================================
#  CrewAI Studio container
# ============================================================
#  Two-stage build:
#   1. Node builds the Next.js standalone bundle.
#   2. Debian-slim runtime carries Node + Python so the runner can
#      spawn `python3 run.py` to actually execute crews.
#
#  The Python toolchain (crewai + crewai-tools) is pinned into a venv
#  baked into the image. CREW_PYTHON_BIN points at that venv so the
#  runner doesn't pick up a system Python that may not have crewai.
# ============================================================

# ---- Build stage ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# NEXT_PUBLIC_CONTAINER_MODE flips on UI warnings that only matter
# in deployed environments (e.g. stdio MCP).
ENV NEXT_PUBLIC_CONTAINER_MODE=1

# Native deps for better-sqlite3 build (pulled when no prebuilt
# binary matches the host arch — usually a no-op on linux/amd64).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV CONTAINER_MODE=1
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install Python toolchain and create a dedicated venv for crewai. We
# use a venv (not system pip) so apt's externally-managed-environment
# guard doesn't reject installs, and so the install layer stays
# cacheable across rebuilds when only Node code changes.
# tini is included here so PID 1 is a real init that forwards SIGTERM
# to the Node server and the Python subprocess it spawns.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/crewai \
    && /opt/crewai/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/crewai/bin/pip install --no-cache-dir \
        "crewai>=0.150" \
        "crewai-tools>=0.50" \
        "litellm>=1.50.0" \
        "snowflake-connector-python>=3.0"
# - litellm: required because every model id is `snowflake/...`, a
#   LiteLLM-routed provider. CrewAI 1.x made litellm an optional extra.
# - snowflake-connector-python: backs the custom CrewStudioSnowflakeTool
#   in generated crew.py. We bypass crewai-tools' SnowflakeSearchTool
#   so we can use authenticator='oauth' with the SPCS-injected session
#   token (no PAT in deployed environments).

ENV CREW_PYTHON_BIN=/opt/crewai/bin/python3
# crewai imports chromadb at module load and chromadb writes its
# default DB to ~/.local/share/app on first import. Pinning
# CREWAI_STORAGE_DIR to the persistent /data volume keeps that state
# off ephemeral container layers AND avoids a permission error if
# HOME points at a non-existent path. HOME is set explicitly so any
# library that ignores XDG_DATA_HOME still finds a writable place.
ENV HOME=/home/nextjs
ENV CREWAI_STORAGE_DIR=/data/crewai-storage

# Create a real home directory for the runtime user — `adduser --system`
# on Debian defaults HOME to /nonexistent, which breaks anything that
# does Path.home().
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --home /home/nextjs --shell /bin/sh nextjs && \
    mkdir -p /home/nextjs && chown nextjs:nodejs /home/nextjs

# Copy standalone output from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Data directory — overlaid by SPCS stage volume in production. The
# crewai-storage subdir holds chromadb / cache state; the rest is the
# JSON/SQLite store.
RUN mkdir -p /data/crewai-storage && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000

# tini reaps zombies (matters once Node spawns python3 run.py) and
# forwards SIGTERM so SPCS shutdowns terminate the subprocess instead
# of leaking it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
