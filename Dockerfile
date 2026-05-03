FROM oven/bun:1.3.13-slim

WORKDIR /app

# Node + npm are needed because @anthropic-ai/claude-agent-sdk spawns the `claude` CLI
# (a Node binary) as a subprocess. The SDK itself runs fine under Bun, but the brain
# subprocess wants Node on PATH.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src
COPY tsconfig.json ./

ENV PORT=3040
EXPOSE 3040

CMD ["bun", "src/server.ts"]
