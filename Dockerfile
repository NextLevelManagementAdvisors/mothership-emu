FROM oven/bun:1.3.13-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src
COPY tsconfig.json ./

ENV PORT=3040
EXPOSE 3040

CMD ["bun", "src/server.ts"]
