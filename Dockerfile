# Pinned by digest so every build uses the same base. To update:
#   docker pull node:24-slim && docker inspect --format '{{index .RepoDigests 0}}' node:24-slim
ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# Build stage: full deps (TypeScript) to compile src/ into dist/.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps and compiled output only, owned by root and
# read-only to the app user, so a compromised process can't rewrite its code.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# get_playbook serves this to Fo (Wajo has no place for standing instructions).
COPY docs/standing-instructions.md ./docs/standing-instructions.md
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Mount a persistent volume here (compose.yaml does); without one, state is lost on restart.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Starts as root only to fix the volume's owner, then runs the server as "node".
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
