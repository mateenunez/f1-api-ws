FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml .env* ./
RUN pnpm install --frozen-lockfile --force

COPY . ./
RUN pnpm run build

FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app/f1-api-ws

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --force

COPY --from=builder /app/f1-api-ws/dist ./dist
COPY .env* ./

# Create startup script
RUN echo '#!/bin/bash' > /entrypoint.sh && \
    echo 'set -e' >> /entrypoint.sh && \
    echo 'echo "Starting API service..."' >> /entrypoint.sh && \
    echo 'exec pnpm start' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

#EXPOSE 4000
CMD ["/entrypoint.sh"]