FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml .env* ./
RUN pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build

FROM node:20-slim AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/f1-api-ws/dist ./dist

#EXPOSE 4000
CMD ["pnpm", "start"]

FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml .env ./
RUN pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build

FROM node:20-slim AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/f1-api-ws/dist ./dist
COPY .env ./

#EXPOSE 4000
CMD ["pnpm", "start"]