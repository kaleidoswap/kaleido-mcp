FROM node:20-bookworm-slim AS builder
WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# MCP server
COPY kaleido-mcp/package.json ./kaleido-mcp/
RUN cd kaleido-mcp && npm install
COPY kaleido-mcp/ ./kaleido-mcp/
RUN cd kaleido-mcp && npm run build

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3013
ENV KALEIDOSWAP_API_URL=https://api.staging.kaleidoswap.com

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/kaleido-mcp/dist ./dist/
COPY --from=builder /workspace/kaleido-mcp/package.json ./

RUN npm install --omit=dev

EXPOSE 3013

CMD ["node", "dist/index.js"]
