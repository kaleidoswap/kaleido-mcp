FROM node:20-bookworm-slim AS builder
WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3013
ENV KALEIDOSWAP_API_URL=https://api.staging.kaleidoswap.com

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/dist ./dist/
COPY --from=builder /workspace/package.json ./

RUN npm install --omit=dev

EXPOSE 3013

CMD ["node", "dist/index.js"]
