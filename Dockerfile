# API image for CranL (build type: Dockerfile). Built from the repository root.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /repo
RUN corepack enable

# Dependencies first, for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/app/package.json apps/app/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @questify/api build
# The native argon2 library cannot be bundled, so its production dependencies are installed from the
# lockfile into a folder that the runtime image copies.
RUN pnpm --filter @questify/api deploy --legacy --prod /deploy

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# hashing runs on the libuv thread pool; keep spare threads for DNS and file work
ENV NODE_ENV=production PORT=3000 UV_THREADPOOL_SIZE=8
WORKDIR /srv
# The bundle contains every dependency except the native argon2 library.
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist/server.cjs ./server.cjs
COPY --from=build /repo/apps/api/dist/migrate-cli.cjs ./migrate.cjs
COPY --from=build /repo/apps/api/dist/staff-cli.cjs ./staff.cjs
COPY --from=build /repo/apps/api/dist/migrations ./migrations
COPY --from=build /repo/apps/api/dist/db ./db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server.cjs"]
