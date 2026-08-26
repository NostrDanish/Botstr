# Botstr self-hosted — the whole platform in one container.
# The same worker.ts that runs on Cloudflare runs here via wrangler's local
# runtime (miniflare): Durable Objects, D1 (SQLite) and R2 are emulated
# locally, so self-hosted behavior matches cloud behavior by construction.
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install
COPY . .

RUN npx vite build

EXPOSE 8787
VOLUME ["/data"]

# BOTSTR_SECRET encrypts every bot key at rest — required, like in production.
CMD ["sh", "-c", "npx wrangler d1 migrations apply botstr --local --persist-to /data || true; printf 'BOTSTR_SECRET=%s\\n' \"$BOTSTR_SECRET\" > .dev.vars; exec npx wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to /data"]
