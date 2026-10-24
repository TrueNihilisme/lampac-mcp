# lampac-mcp: MCP server + collection feed for the Lampa carousel.
# No runtime dependencies: only Node's built-in modules are used, so there is no npm install step.
FROM node:22.23.3-alpine3.24

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY plugin ./plugin

# Inside a container the server must listen on all interfaces; publish the port only where you need it.
# Collections live in /data; mount a volume there to keep them across restarts.
ENV HOST=0.0.0.0 \
    PORT=8787 \
    COLLECTIONS_FILE=/data/collections.json

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8787/api/collection || exit 1

CMD ["node", "src/server.mjs"]
