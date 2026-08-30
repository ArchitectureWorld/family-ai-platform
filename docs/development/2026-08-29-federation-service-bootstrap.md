# Federation product service credential bootstrap

This is an offline, one-shot administration command. It never accepts a raw credential through
argv or environment variables, and Gateway startup never provisions a service automatically.

Build the exact checkout first:

```bash
npm ci
npm run build:gateway
```

Prepare an already migrated Gateway V14 database and one credential file in the same protected
runtime directory. The directory and both files must be owned by the invoking uid; the directory
must not be group/other writable. The credential must be a single 16..4096-byte visible-ASCII line,
mode `0600`, with one hard link. The database must have one hard link and must not be group/other
writable. Stop Gateway and every other SQLite user before running the command.

The CLI checkpoints existing WAL state, switches the offline database to DELETE journaling, and
holds one exclusive transaction through provisioning. Normal Gateway startup explicitly enables
WAL again. Run exactly once for each product identity:

```bash
GATEWAY_DATABASE_PATH=/absolute/protected/runtime/gateway.sqlite npm --silent run provision:federation-service -- \
  --service-ref service:canvas \
  --product canvas \
  --credential-file /absolute/protected/runtime/canvas.credential \
  --database /absolute/protected/runtime/gateway.sqlite
```

Use `service:me` and `--product me` for ME-System. The command prints only the fixed ready status,
serviceRef and product. Exact replay is safe; drift and revoked identities fail closed.

For an immutable container image, mount the protected runtime directory with numeric owner
1000:1000, stop the normal Gateway container, and select the provision role on the image's protected
launcher entrypoint:

```bash
docker run --rm \
  --mount type=bind,src=/absolute/protected/runtime,dst=/runtime \
  --env GATEWAY_DATABASE_PATH=/runtime/gateway.sqlite \
  FAMILY_IMAGE \
  node apps/gateway/dist/provisionFederationService.js \
  --service-ref service:canvas \
  --product canvas \
  --credential-file /runtime/canvas.credential \
  --database /runtime/gateway.sqlite
```

The token is present only in the mounted credential file. Do not place it in Compose environment,
container environment, labels, command arguments, logs, shell variables, or deployment manifests.
