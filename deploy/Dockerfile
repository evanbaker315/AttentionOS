# syntax=docker/dockerfile:1.7
#
# AttentionOS in one image: Studio + the Autopilot worker (`attentionos up`), the media tools (ffmpeg, yt-dlp,
# Python 3.12 media-py) and Claude Code, which runs your agents on your own Claude login.
#
# Built from this checkout (no npm release needed). From the repo root:
#
#   docker build -f deploy/Dockerfile -t attentionos:local .
#
# Usually you don't run this yourself: `docker compose build` (or `./aos update`) builds it. See docs/install.md.
#
# Nothing personal is baked in. Your workspace (Brand Kit, config, media) is a folder on your computer mounted at
# /workspace; the database runs in its own container; your Claude sign-in token (CLAUDE_CODE_OAUTH_TOKEN) and the
# Studio access key come from the stack's env file at run time.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.0
# A static ffmpeg + ffprobe (with libx264, libzimg, loudnorm, libass): ~110 MB, against ~400 MB for Debian's ffmpeg,
# which drags in Mesa and LLVM. Swap for another image that has /ffmpeg and /ffprobe if you prefer.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1

FROM ${UV_IMAGE} AS uv
FROM ${FFMPEG_IMAGE} AS ffmpeg

# ───────────────────────────── 1. Build the attentionos package from source ─────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src

# Dependencies first (cached until the lockfile changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=aos-pnpm,target=/pnpm/store pnpm fetch --store-dir /pnpm/store

COPY . .
# The lockfile must match (a release build). While developing, a checkout whose lockfile lags behind can build with
# --build-arg PNPM_INSTALL_FLAGS=--no-frozen-lockfile
ARG PNPM_INSTALL_FLAGS=--frozen-lockfile
RUN --mount=type=cache,id=aos-pnpm,target=/pnpm/store pnpm install --prefer-offline --store-dir /pnpm/store ${PNPM_INSTALL_FLAGS}

# The CLI bundle plus the Studio standalone build (apps/cli/dist, with Studio in dist/assets/studio).
RUN pnpm --filter attentionos build

# A production install of the package, laid out exactly as npm would install it: dist/ plus its npm dependencies.
# (The workspace:* devDependencies are bundled into dist, so they're dropped from the manifest.)
RUN --mount=type=cache,id=aos-pnpm,target=/pnpm/store \
    pnpm --filter attentionos deploy --legacy --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm/store /out/attentionos \
 && rm -rf /out/attentionos/dist/assets/media-py/.venv

# ───────────────────────────── 2. Runtime ─────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# Python extras for media-py. Extras that this checkout's media-py doesn't define are skipped with a note,
# so the image keeps building while new extras land.
ARG MEDIA_EXTRAS="asr vision embed"
ARG PYTHON_VERSION=3.12
ARG CLAUDE_CODE_VERSION=2.1.283
ARG YTDLP_VERSION=2026.8.19

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ATTENTIONOS_CONTAINER=1 \
    ATTENTIONOS_HOME=/opt/attentionos \
    ATTENTIONOS_MEDIA_PY_DIR=/opt/attentionos/dist/assets/media-py \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_FROZEN=1 \
    XDG_CACHE_HOME=/data/cache \
    UV_CACHE_DIR=/data/cache/uv \
    ATTENTIONOS_CACHE_DIR=/data/cache/attentionos \
    HF_HOME=/data/cache/huggingface \
    FASTEMBED_CACHE_PATH=/data/cache/fastembed \
    CLAUDE_CONFIG_DIR=/data/claude \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    HOME=/home/attentionos

# tini to pass signals cleanly, certificates for HTTPS; ffmpeg + ffprobe for editing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
# The editor and trial reels need these encoders and filters (trial reels: speed with pitch kept, colour filters,
# PNG caption overlays). Fail the build early if a swapped-in ffmpeg lacks one.
RUN ffmpeg -hide_banner -version | head -1 \
 && ffmpeg -hide_banner -encoders | grep -Eq ' libx264 ' \
 && for f in atempo colorbalance eq vibrance overlay setpts scale loudnorm; do \
      ffmpeg -hide_banner -filters | grep -Eq " ${f} " || { echo "ffmpeg is missing the ${f} filter"; exit 1; }; \
    done

# uv, a managed Python 3.12 and yt-dlp (research downloads), all owned by root and read-only for the app.
COPY --from=uv /uv /uvx /usr/local/bin/
RUN --mount=type=cache,id=aos-uv,target=/root/.cache/uv \
    UV_CACHE_DIR=/root/.cache/uv UV_PYTHON_DOWNLOADS=automatic uv python install "${PYTHON_VERSION}" \
 && UV_CACHE_DIR=/root/.cache/uv uv tool install --python "${PYTHON_VERSION}" "yt-dlp==${YTDLP_VERSION}" \
 && yt-dlp --version

# Claude Code: runs your agents (`claude -p`) on your own Claude plan. It never holds a login in the image.
# Updated by rebuilding (`./aos update`), not by itself.
RUN npm install -g --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* \
 && claude --version

# The app user (uid 1000) owns /workspace and /data; everything else stays root-owned.
RUN userdel -r node 2>/dev/null || true \
 && groupadd --gid 1000 attentionos \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/attentionos --shell /bin/bash attentionos \
 && mkdir -p /workspace /data/cache /data/claude \
 && chown -R attentionos:attentionos /workspace /data

# AttentionOS itself (CLI, worker, Studio standalone build, engine assets).
COPY --from=build /out/attentionos /opt/attentionos
RUN ln -s /opt/attentionos/dist/bin.js /usr/local/bin/attentionos \
 && chmod +x /opt/attentionos/dist/bin.js \
 && attentionos --version

# The media tools' Python environment, synced from media-py's lockfile with the extras above.
RUN --mount=type=cache,id=aos-uv,target=/root/.cache/uv \
    cd "${ATTENTIONOS_MEDIA_PY_DIR}" \
 && extras="" \
 && for e in ${MEDIA_EXTRAS}; do \
      if grep -Eq "^${e}[[:space:]]*=" pyproject.toml; then extras="${extras} --extra ${e}"; \
      else echo "NOTE: media-py has no '${e}' extra in this checkout; building without it."; fi; \
    done \
 && UV_CACHE_DIR=/root/.cache/uv uv sync --no-dev --no-install-project --python "${PYTHON_VERSION}" ${extras} \
 && UV_CACHE_DIR=/root/.cache/uv uv sync --no-dev --python "${PYTHON_VERSION}" ${extras} \
 && echo "${extras}" > .extras \
 && find .venv -type d -name tests -prune -exec rm -rf {} + \
 && chown -R attentionos:attentionos "${ATTENTIONOS_MEDIA_PY_DIR}" \
 && su attentionos -s /bin/sh -c "UV_CACHE_DIR=/tmp/uv uv run --no-sync --project ${ATTENTIONOS_MEDIA_PY_DIR} attentionos-media version" \
 && rm -rf /tmp/uv

COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/attentionos-entrypoint
COPY deploy/write-mcp-config.cjs /usr/local/lib/attentionos/write-mcp-config.cjs
# A checkout made with Git for Windows can carry CRLF line endings, which breaks the entrypoint ("/bin/sh^M").
RUN sed -i 's/\r$//' /usr/local/bin/attentionos-entrypoint

USER attentionos
WORKDIR /workspace
VOLUME ["/data"]

# Studio, and the webhook receiver for your publishing provider.
EXPOSE 4747 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/attentionos-entrypoint"]
CMD ["up"]
