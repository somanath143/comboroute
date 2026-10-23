FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# No lockfile generated in the offline authoring environment. A lockfile should be
# generated with npm install and committed; at that point replace with `npm ci`.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build
RUN npm prune --omit=dev
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 REQUIRE_DEMO_AUTH=true
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node","apps/api/dist/index.js"]
