# Image de la console : construite depuis les sources de console/ (docker build -f
# deploy/Dockerfile .), pour le projet du moteur (deploy/compose.yaml) comme pour une console seule.
# Construction Next.js autonome, sans les dépendances de développement dans l'image finale.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-alpine
RUN addgroup -S -g 10001 console \
    && adduser -S -D -u 10001 -G console -H -h /nonexistent console \
    && mkdir -p /data /shared && chown 10001:10001 /data /shared
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3000
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/public ./public
USER 10001
VOLUME ["/data"]
CMD ["node", "server.js"]
