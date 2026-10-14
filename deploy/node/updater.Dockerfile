# Image of the updater (updater.mjs, mounted from runtime/): Node.js plus the
# Docker and git command-line tools it drives. Built by install.sh.
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose git tar
