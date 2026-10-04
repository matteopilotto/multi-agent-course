# One image for the three backend processes: the agent, the jobs worker and the gateway.
# fly.agent.toml and fly.gateway.toml pick which one runs. Build from the assignment root:
#   fly deploy -c fly.agent.toml   |   fly deploy -c fly.gateway.toml

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci
COPY packages/contract packages/contract
COPY backend/agent backend/agent
COPY backend/gateway backend/gateway
RUN npm run build -w @lumina/contract -w @lumina/agent -w @lumina/gateway \
  && npm prune --omit=dev \
  && rm -rf web packages/contract/src backend/agent/src backend/gateway/src

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
# cost.ts prices answers from the declared SLA, read as ../../benchmark/sla.json.
COPY benchmark/sla.json benchmark/
# The eval's report, if it has run (the gateway serves it at /evals/report.json); .dockerignore
# lets only reports/report.json in, and before the first eval there is no reports/ at all.
# package.json is only there so the COPY has a match then.
COPY package.json reports* reports/
RUN rm reports/package.json && mkdir -p runs && chown node:node runs
USER node
# Both services resolve their files from ../../ (runs/, benchmark/, reports/), so they run
# from a backend folder.
WORKDIR /app/backend/agent
CMD ["node", "dist/index.js"]
