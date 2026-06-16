# Slim, single-stage image. The app has one runtime dependency (express),
# so a multi-stage build buys little here.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# App source.
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Data + icons live on a mounted volume.
RUN mkdir -p /data/icons && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

# Container-level healthcheck hits the unauthenticated /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
