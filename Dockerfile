FROM node:22.16.0-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json SECURITY.md ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-adapter-sdk/package.json packages/provider-adapter-sdk/package.json
COPY apps/gateway/package.json apps/gateway/package.json

RUN npm ci

COPY .gitignore Dockerfile compose.yaml ./
RUN printf '%s\n' \
    '.git' \
    '.github' \
    '.runtime' \
    'node_modules' \
    '**/node_modules' \
    '**/dist' \
    'coverage' \
    'clients/ios' \
    '.env' \
    '.env.*' \
    '.npmrc' \
    '.npmrc.*' \
    '.yarnrc.yml' \
    '.pnpmfile.cjs' \
    '*.sqlite' \
    '*.sqlite-*' \
    '*.log' \
    '*.pem' \
    '*.key' \
    '*.p12' \
    '*.pfx' \
    '*.mobileprovision' \
    '*.credentials.json' \
    '*.secrets.json' \
    'credentials' \
    'secrets' \
    'docs/acceptance/runtime' \
    'xcuserdata' \
    'DerivedData' \
    > .dockerignore \
  && git init -q \
  && git config user.email 'build@family-ai.invalid' \
  && git config user.name 'Family AI Build' \
  && git add SECURITY.md
COPY scripts scripts
COPY packages packages
COPY apps apps

RUN npm run check \
  && npm prune --omit=dev

FROM node:22.16.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package.json
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/provider-adapter-sdk/package.json /app/packages/provider-adapter-sdk/package.json
COPY --from=build --chown=node:node /app/packages/provider-adapter-sdk/dist /app/packages/provider-adapter-sdk/dist
COPY --from=build --chown=node:node /app/apps/gateway/package.json /app/apps/gateway/package.json
COPY --from=build --chown=node:node /app/apps/gateway/dist /app/apps/gateway/dist
COPY --from=build --chown=node:node /app/apps/gateway/public /app/apps/gateway/public

USER node
EXPOSE 8790

CMD ["node", "apps/gateway/dist/index.js"]
