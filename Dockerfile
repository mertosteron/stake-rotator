FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production

# Override CMD per service:
#   bot:    docker run ... stake-rotator pnpm bot
#   worker: docker run ... stake-rotator pnpm worker
CMD ["pnpm", "bot"]
