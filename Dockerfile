# syntax=docker/dockerfile:1
# Agency Intelligence OS — production image (API or worker; PostgreSQL).
# Based on the official Playwright image so Chromium and its system libraries match the
# Playwright version in package-lock.json.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.56.1-noble

FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# PostgreSQL Prisma client + SPA + server bundles, then drop dev dependencies.
RUN npx prisma generate --schema prisma/postgres/schema.prisma \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${PLAYWRIGHT_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data
COPY --from=build --chown=pwuser:pwuser /app/package.json ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --from=build --chown=pwuser:pwuser /app/prisma ./prisma
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# API by default; the worker uses the same image with: node dist/server/worker.js
CMD ["node", "dist/server/index.js"]
