# Runtime image of a node set up by the one-line installer (install.sh).
#
# Built on the new server from the bundle the inviting node hands over: the
# compiled server and admin panel are copied as they are, so the new node runs
# exactly the inviting node's version (nodes with different schemas pause
# replication). Mirrors the runner stage of the repository's Dockerfile.
FROM node:22-alpine
WORKDIR /app

# openssl for Prisma's Alpine engine, su-exec for the unprivileged hand-off in
# entrypoint.sh, mariadb-client for the backup service (dbBackup.ts).
RUN apk add --no-cache openssl su-exec mariadb-client && \
    addgroup -S -g 10001 pokyh; \
    adduser -S -D -H -u 10001 -G pokyh pokyh; \
    mkdir -p /app/logs /app/backups /app/data/bootstrap; \
    chown -R pokyh:pokyh /app/logs /app/backups /app/data

# Production dependencies exactly as locked by the inviting node's build.
COPY --chown=pokyh:pokyh package*.json ./
RUN npm ci --omit=dev

COPY --chown=pokyh:pokyh dist ./dist
COPY --chown=pokyh:pokyh admin/dist ./admin/dist
COPY --chown=pokyh:pokyh prisma ./prisma
RUN npx prisma generate

COPY --chown=pokyh:pokyh scripts ./scripts
# Kept so this node can set up further nodes in turn.
COPY --chown=pokyh:pokyh deploy ./deploy

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 4000 4100
ENTRYPOINT ["./entrypoint.sh"]
