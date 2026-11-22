# api-hg as one HTTP service for Kubernetes.
# Build context is the repo root:  docker build -f deploy/Dockerfile -t api-hg:dev .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json ./
COPY lambdas ./lambdas
COPY server ./server
COPY scripts ./scripts
COPY sql ./sql
RUN npx tsc -p tsconfig.server.json && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/sql ./sql
COPY package.json ./
USER app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Migrations: `node dist/scripts/migrate.js` (same env) before the first start.
CMD ["node", "dist/server/index.js"]
