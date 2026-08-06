# --- Base image ---
FROM node:20-alpine AS base
WORKDIR /usr/src/app

# --- Dependencies (cached layer) ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Build: generate Prisma client ---
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
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
