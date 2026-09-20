# Built from the repo root. The context has to include pnpm-workspace.yaml
# and packages/time, because this service resolves `@enamel/time` through
# the workspace rather than from the registry — a context scoped to
# apps/core would fail to install.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

# Manifests first, so a dependency change is what invalidates the install
# layer rather than every source edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/time/package.json ./packages/time/
COPY apps/core/package.json ./apps/core/
RUN pnpm install --filter @enamel/core... --frozen-lockfile || pnpm install --filter @enamel/core...

COPY packages/time ./packages/time
COPY apps/core ./apps/core
RUN pnpm --filter @enamel/time build && pnpm --filter @enamel/core build

FROM node:22-alpine
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production

COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/time/package.json ./packages/time/
COPY apps/core/package.json ./apps/core/
RUN pnpm install --filter @enamel/core... --prod --frozen-lockfile || pnpm install --filter @enamel/core... --prod

COPY --from=build /repo/packages/time/dist ./packages/time/dist
COPY --from=build /repo/apps/core/dist ./apps/core/dist

# Not root. The service reads a database and sends mail; neither needs it.
USER node
WORKDIR /repo/apps/core
EXPOSE 8057
CMD ["node", "dist/main.js"]
