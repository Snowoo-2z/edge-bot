# syntax=docker/dockerfile:1
#
# Edge en conteneur : c'est ce que veulent Koyeb, Fly.io, Railway, Render (et un VPS).
# Deux etages — on construit le TypeScript avec les devDeps, on ne livre que dist/.
# L'image finale fait ~130 MB et tourne en utilisateur non-root.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.typecheck.json ./
COPY src ./src
RUN npm run build && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production TZ=Europe/Paris
WORKDIR /app
# tini = PID 1 qui transmet SIGTERM => Edge se coupe proprement (commandes gardées, base vidée)
RUN apk add --no-cache tini tzdata \
 && addgroup -S edge && adduser -S edge -G edge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrations/ est lu au demarrage (EDGE_AUTO_MIGRATE implicite : boot() applique deja les .sql)
COPY migrations ./migrations
USER edge
EXPOSE 8080
# La sonde ne doit JAMAIS echouer parce que Discord est long a se connecter : /health
# repond 200 des le premier instant. C'est /ready qui dit si Edge est operationnel.
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
