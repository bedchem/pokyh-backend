# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Backend deps + build
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# Admin panel build
COPY admin/package*.json ./admin/
RUN cd admin && npm ci

COPY admin ./admin
RUN cd admin && npm run build

# ── Stage 2: Production image ──────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# openssl is required by Prisma's Alpine engine. `su-exec` lets the short
# bootstrap entrypoint hand the application to a non-root account.
RUN apk add --no-cache openssl su-exec && \
    addgroup -S -g 10001 pokyh; \
    adduser -S -D -H -u 10001 -G pokyh pokyh; \
    mkdir -p /app/logs; \
    chown -R pokyh:pokyh /app/logs

# Production Node deps (prisma is a dependency, not devDependency)
COPY --chown=pokyh:pokyh package*.json ./
RUN npm ci --omit=dev

# Copy built output
COPY --chown=pokyh:pokyh --from=builder /app/dist ./dist
COPY --chown=pokyh:pokyh --from=builder /app/admin/dist ./admin/dist
COPY --chown=pokyh:pokyh prisma ./prisma

# Generate Prisma client for this OS/arch (cannot copy from builder — native binaries differ)
RUN npx prisma generate

# Admin scripts (make-admin, create-user, etc.)
COPY --chown=pokyh:pokyh scripts ./scripts

# Startup script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
