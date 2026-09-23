FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
ENV MAKEFLAGS=-j2
RUN npm ci --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN mkdir -p /data /backups /secrets && chown node:node /data /backups /secrets
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    DB_PATH=/data/collector.sqlite ADMIN_SOCKET=/data/run/admin.sock \
    SIGNING_KEY_FILE=/secrets/signing.pem ADMIN_TOKEN_FILE=/secrets/admin.token \
    BACKUP_DIR=/backups REAL_COLLECTION_ENABLED=false
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
