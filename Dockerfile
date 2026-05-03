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

# openssl required by Prisma engine binaries on Alpine (musl-based)
RUN apk add --no-cache openssl

# Install cloudflared (auto-detect arch for arm64/amd64)
RUN apk add --no-cache curl && \
    ARCH=$(uname -m) && \
    CF_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared && \
    cloudflared --version

# Production Node deps (prisma is a dependency, not devDependency)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/admin/dist ./admin/dist
COPY prisma ./prisma

# Generate Prisma client for this OS/arch (cannot copy from builder — native binaries differ)
RUN npx prisma generate

# Admin scripts (make-admin, create-user, etc.)
COPY scripts ./scripts

# Startup script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
