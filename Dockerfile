# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# tsconfig + src copied before npm ci because the package's "prepare" script runs tsc on install
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
