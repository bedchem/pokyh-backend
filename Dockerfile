# Keep the tunnel binary reproducible: a floating `latest` URL makes a rebuild
# change production code without review. The checksums are the upstream release
# assets for this pinned version (amd64 and arm64 respectively).
ARG CLOUDFLARED_VERSION=2026.9.1
ARG CLOUDFLARED_AMD64_SHA256=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc
ARG CLOUDFLARED_ARM64_SHA256=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3

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

ARG CLOUDFLARED_VERSION
ARG CLOUDFLARED_AMD64_SHA256
ARG CLOUDFLARED_ARM64_SHA256

# openssl is required by Prisma's Alpine engine. `su-exec` lets the short
# bootstrap entrypoint hand the application to a non-root account.
RUN apk add --no-cache openssl curl su-exec && \
    set -eux; \
    case "$(uname -m)" in \
      x86_64) CF_ARCH=amd64; CF_SHA256="$CLOUDFLARED_AMD64_SHA256" ;; \
      aarch64) CF_ARCH=arm64; CF_SHA256="$CLOUDFLARED_ARM64_SHA256" ;; \
      *) echo "Unsupported cloudflared architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl --fail --show-error --location --proto '=https' --tlsv1.2 \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CF_ARCH}" \
      --output /usr/local/bin/cloudflared; \
    echo "${CF_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/cloudflared; \
    cloudflared --version; \
    addgroup -S -g 10001 pokyh; \
    adduser -S -D -H -u 10001 -G pokyh pokyh; \
    mkdir -p /var/lib/pokyh/.cloudflared /app/logs; \
    chown -R pokyh:pokyh /var/lib/pokyh /app

ENV HOME=/var/lib/pokyh

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
