# Build stage: full deps (TypeScript) to compile src/ into dist/.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps and compiled output only.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Mount a persistent volume here (fly.toml / render.yaml do); without one, state is lost on restart.
# Runs as root because Fly volumes and Render disks mount root-owned.
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
