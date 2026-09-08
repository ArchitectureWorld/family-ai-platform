FROM --platform=linux/amd64 node:22.16.0-bookworm-slim@sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488 AS build

ARG DEBIAN_SNAPSHOT=http://snapshot.debian.org/archive/debian/20250611T000000Z
ARG DEBIAN_SECURITY_SNAPSHOT=http://snapshot.debian.org/archive/debian-security/20250611T000000Z
ARG PYTHON3_VERSION=3.11.2-1+b1
ARG MAKE_VERSION=4.3-4.1
ARG GXX_VERSION=4:12.2.0-3
ARG GIT_VERSION=1:2.39.5-0+deb12u2

RUN printf '%s\n' \
      "deb [check-valid-until=no] ${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] ${DEBIAN_SECURITY_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=8 -o Acquire::http::Timeout=20 -o Acquire::http::Pipeline-Depth=0 update \
  && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=20 -o Acquire::http::Pipeline-Depth=0 install -y --no-install-recommends \
      "python3=${PYTHON3_VERSION}" \
      "make=${MAKE_VERSION}" \
      "g++=${GXX_VERSION}" \
      "git=${GIT_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json tsconfig.base.json SECURITY.md ./
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/provider-adapter-sdk/package.json packages/provider-adapter-sdk/package.json
COPY --chown=node:node apps/gateway/package.json apps/gateway/package.json

RUN npm ci

COPY --chown=node:node .gitignore Dockerfile compose.yaml ./
COPY --chown=node:node AGENTS.md ./
COPY --chown=node:node .github/workflows/ci.yml .github/workflows/ci.yml
COPY --chown=node:node docs/development/2026-07-25-member-web-product-workbench.md docs/development/2026-07-25-member-web-product-workbench.md
COPY --chown=node:node docs/development/2026-08-29-federation-service-bootstrap.md docs/development/2026-08-29-federation-service-bootstrap.md
RUN printf '%s\n' \
    '.git' \
    '.github' \
    '.runtime' \
    '.runtime-preview/' \
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
COPY --chown=node:node scripts scripts
COPY --chown=node:node packages packages
COPY --chown=node:node apps apps

ENV FAMILY_AI_CONTAINER_BUILD=1

RUN npm run check \
  && npm prune --omit=dev

FROM --platform=linux/amd64 node:22.16.0-bookworm-slim@sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488 AS runtime

ARG SOURCE_COMMIT=local-unverified
ARG CLIENT_DATABASE_VERSION=2
ARG SCHEMA_HEAD=15
ARG RELEASE_CAPABILITY_RECEIPT_SHA256=local-unverified
ARG RELEASE_BUILD_INPUTS_SHA256=local-unverified
ARG BUILD_INPUT_TREE_HASH=local-unverified
ARG BASE_IMAGE_DIGEST=sha256:1471ea646673136b8308550ac14b36d847ffb21c24bc31828279e443c924e488
ARG TARGET_PLATFORM=linux/amd64
ARG DEBIAN_SNAPSHOT=http://snapshot.debian.org/archive/debian/20250611T000000Z
ARG DEBIAN_SECURITY_SNAPSHOT=http://snapshot.debian.org/archive/debian-security/20250611T000000Z
ARG PYTHON3_VERSION=3.11.2-1+b1
ARG TOOLCHAIN_MATERIAL=local-unverified

LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.architectureworld.family-ai.client-database-version="${CLIENT_DATABASE_VERSION}" \
      org.architectureworld.family-ai.schema-head="${SCHEMA_HEAD}" \
      org.architectureworld.family-ai.gateway-database-flock-v1="true" \
      org.architectureworld.family-ai.protected-wal-recovery-v1="true" \
      org.architectureworld.family-ai.release-capability-receipt-sha256="${RELEASE_CAPABILITY_RECEIPT_SHA256}" \
      org.architectureworld.family-ai.release-build-inputs-sha256="${RELEASE_BUILD_INPUTS_SHA256}" \
      org.architectureworld.family-ai.build-input-tree-hash="${BUILD_INPUT_TREE_HASH}" \
      org.architectureworld.family-ai.base-image-digest="${BASE_IMAGE_DIGEST}" \
      org.architectureworld.family-ai.target-platform="${TARGET_PLATFORM}" \
      org.architectureworld.family-ai.debian-snapshot="${DEBIAN_SNAPSHOT}" \
      org.architectureworld.family-ai.toolchain-material="${TOOLCHAIN_MATERIAL}"

ENV NODE_ENV=production
WORKDIR /app

RUN printf '%s\n' \
      "deb [check-valid-until=no] ${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] ${DEBIAN_SECURITY_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=8 update \
  && apt-get -o Acquire::Retries=8 install -y --no-install-recommends \
      "python3=${PYTHON3_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package.json
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
RUN rm /app/node_modules/@family-ai/contracts /app/node_modules/@family-ai/provider-adapter-sdk
COPY --from=build --chown=node:node /app/packages/contracts/package.json /app/node_modules/@family-ai/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist /app/node_modules/@family-ai/contracts/dist
COPY --from=build --chown=node:node /app/packages/provider-adapter-sdk/package.json /app/node_modules/@family-ai/provider-adapter-sdk/package.json
COPY --from=build --chown=node:node /app/packages/provider-adapter-sdk/dist /app/node_modules/@family-ai/provider-adapter-sdk/dist
COPY --from=build --chown=node:node /app/apps/gateway/package.json /app/apps/gateway/package.json
COPY --from=build --chown=node:node /app/apps/gateway/dist /app/apps/gateway/dist
COPY --from=build --chown=node:node /app/apps/gateway/runtime /app/apps/gateway/runtime
COPY --from=build --chown=node:node /app/apps/gateway/member-public /app/apps/gateway/member-public
COPY --from=build --chown=node:node /app/apps/gateway/admin-public /app/apps/gateway/admin-public
COPY --from=build --chown=node:node /app/apps/gateway/public /app/apps/gateway/public
RUN chmod -R a+rX /app
USER 65532:65532
RUN node --input-type=module -e 'await import("@family-ai/contracts"); await import("@family-ai/provider-adapter-sdk"); await import("./apps/gateway/dist/app.js"); const { access } = await import("node:fs/promises"); await access("./apps/gateway/member-public/index.html"); await access("./apps/gateway/public/qr.js");' \
  && python3 apps/gateway/runtime/gateway_lock_exec.py --self-check \
  && node apps/gateway/dist/recoverGatewayDatabase.js --self-check

USER node
EXPOSE 8790

ENTRYPOINT ["python3", "apps/gateway/runtime/gateway_lock_exec.py", "--database-from-env", "GATEWAY_DATABASE_PATH", "--"]
CMD ["node", "apps/gateway/dist/index.js"]
