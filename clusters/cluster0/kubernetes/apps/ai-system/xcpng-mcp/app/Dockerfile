# shrinedogg/xo-mcp:1.4.4-node22
#
# Official @xen-orchestra/mcp 1.4.4 (Vates) baked onto the mcp-proxy base so
# the bridge pod needs no init container and no staging volume. node 22 is
# musl-linked to match the mcp-proxy base image (node 22 needs no libatomic,
# unlike node 26). Build + push happens on the laptop (the cluster cannot
# build images):
#
#   docker buildx build --platform linux/amd64 -t docker.io/shrinedogg/xo-mcp:1.4.4-node22 .
#   docker push docker.io/shrinedogg/xo-mcp:1.4.4-node22
#
# The pod is the definitive gate for XO 6.5+ compatibility: on an older XO
# the binary exits at startup with "Unable to verify MCP status (HTTP 404)".
FROM node:22-alpine AS npm
RUN npm install -g --omit=dev @xen-orchestra/mcp@1.4.4
FROM ghcr.io/sparfenyuk/mcp-proxy:v0.15.0
COPY --from=npm /usr/local/bin/node /usr/local/bin/node
COPY --from=npm /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=npm /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=npm /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=npm /usr/local/lib/node_modules/@xen-orchestra/mcp/bin/xo-mcp.mjs /usr/local/bin/xo-mcp
RUN chmod +x /usr/local/bin/xo-mcp
