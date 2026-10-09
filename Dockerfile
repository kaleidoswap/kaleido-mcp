FROM node:22-bookworm-slim AS builder
WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --ignore-scripts
COPY . .
# Spark and Liquid are optional peers (devDependencies here); promote them to dependencies so the
# image ships every wallet, then drop the build tooling.
RUN npm run build \
  && node -e "const fs=require('fs');const p=require('./package.json');for(const n of Object.keys(p.peerDependencies)){p.dependencies[n]=p.devDependencies[n];delete p.devDependencies[n]}fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
  && npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3013
# Container ingress requires MCP_AUTH_TOKEN at runtime.
ENV MCP_HOST=0.0.0.0

COPY --from=builder /workspace/dist ./dist/
COPY --from=builder /workspace/package.json ./
COPY --from=builder /workspace/node_modules ./node_modules/

EXPOSE 3013

CMD ["node", "dist/index.js"]
