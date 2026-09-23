FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
USER 1000:1000
ENV HOST=0.0.0.0 PORT=3100 SNAPSHOT_PATH=/snapshot/snapshot.json NODE_ENV=production
EXPOSE 3100
CMD ["node", "src/main.mjs"]
