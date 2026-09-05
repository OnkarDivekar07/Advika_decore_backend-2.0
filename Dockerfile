# --- Base image ---
FROM node:20-alpine AS base
WORKDIR /usr/src/app

# --- Dependencies (cached layer) ---
FROM base AS deps
COPY package.json package-lock.json ./
# prisma/ must exist before `npm ci` here — package.json now has a
# `postinstall: prisma generate` hook (added so a plain `npm install`/`npm
# ci` on a non-Docker platform, e.g. Render/Railway/Fly.io per
# ecosystem.config.js's own comment, is enough to produce a working Prisma
# client on its own) and `prisma generate` fails without the schema file
# present. This stage's own generated client is never actually used at
# runtime (the runtime image copies node_modules/.prisma from the `build`
# stage below, not this one) but it still has to succeed for `npm ci`
# itself to complete.
COPY prisma ./prisma
RUN npm ci --omit=dev

# --- Build: generate Prisma client ---
FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
# Redundant with the postinstall hook above (already ran once during `npm
# ci`) — kept explicit anyway as a harmless, idempotent safeguard so this
# stage's actually-used Prisma client doesn't silently depend on
# postinstall alone ever working correctly.
RUN npx prisma generate
COPY . .

# --- Runtime image ---
FROM base AS runtime
ENV NODE_ENV=production

# Run as a non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY . .

RUN chown -R nodejs:nodejs /usr/src/app
USER nodejs

EXPOSE 5000

CMD ["node", "server.js"]
