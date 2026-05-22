# ------------------------------
# Builder stage
# ------------------------------
FROM node:22 AS builder

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml .env* ./
RUN pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build

# ------------------------------
# Production stage
# ------------------------------
FROM node:22 AS production

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/f1-api-ws/dist ./dist
COPY .env* ./

CMD ["pnpm", "start"]