# API image for CranL (build type: Dockerfile). Built from the repository root.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /repo
RUN corepack enable

# Dependencies first, for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/app/package.json apps/app/
COPY packages/shared/package.json packages/shared/
# Only the API and what it depends on (not the Expo app or the web app).
RUN pnpm install --frozen-lockfile --filter @questify/api...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @questify/api build
# The native argon2 and sharp libraries cannot be bundled, so their production dependencies (sharp's libvips for
# musl among them) are installed from the lockfile into a folder that the runtime image copies.
RUN pnpm --filter @questify/api deploy --legacy --prod /deploy

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
# hashing runs on the libuv thread pool; keep spare threads for DNS and file work
ENV NODE_ENV=production PORT=3000 UV_THREADPOOL_SIZE=8
WORKDIR /srv
# The bundle contains every dependency except the native argon2 and sharp libraries.
COPY --from=build /deploy/node_modules ./node_modules
# Photos (T-301b): the image is refused unless sharp loads its musl build and re-encodes a JPEG here.
RUN node -e "require('sharp')({create:{width:8,height:8,channels:3,background:'#fff'}}).rotate().jpeg().toBuffer().then((b)=>{if(b[0]!==0xff||b[1]!==0xd8)process.exit(1)})"
COPY --from=build /repo/apps/api/dist/server.cjs ./server.cjs
COPY --from=build /repo/apps/api/dist/migrate-cli.cjs ./migrate.cjs
COPY --from=build /repo/apps/api/dist/staff-cli.cjs ./staff.cjs
COPY --from=build /repo/apps/api/dist/reward-codes-cli.cjs ./reward-codes.cjs
COPY --from=build /repo/apps/api/dist/migrations ./migrations
COPY --from=build /repo/apps/api/dist/db ./db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server.cjs"]
