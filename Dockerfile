FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY server ./server
RUN npm run typecheck && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY server ./server
COPY shared ./shared

ENV NODE_ENV=production \
    FLEET_BIND_HOST=0.0.0.0 \
    FLEET_PORT=8080 \
    FLEET_UI_DIR=/app/dist

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "server/index.ts"]

FROM alpine:3.22 AS backup

RUN apk add --no-cache docker-cli restic tzdata util-linux-misc

COPY backup/fleet-backup.sh /usr/local/bin/fleet-backup
COPY backup/entrypoint.sh /usr/local/bin/fleet-backup-entrypoint
COPY backup/crontab /etc/crontabs/root

RUN chmod 0755 /usr/local/bin/fleet-backup /usr/local/bin/fleet-backup-entrypoint \
    && chmod 0600 /etc/crontabs/root

ENTRYPOINT ["/usr/local/bin/fleet-backup-entrypoint"]
CMD ["schedule"]
