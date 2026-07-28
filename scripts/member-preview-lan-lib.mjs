import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code) {
  throw new Error(code);
}

export function validatePrivateIpv4(value) {
  if (typeof value !== "string") fail("LAN_PRIVATE_IPV4_INVALID");
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    fail("LAN_PRIVATE_IPV4_INVALID");
  }
  const numbers = parts.map(Number);
  if (numbers.some(number => number < 0 || number > 255)) {
    fail("LAN_PRIVATE_IPV4_INVALID");
  }
  const privateAddress = numbers[0] === 10 ||
    (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
    (numbers[0] === 192 && numbers[1] === 168);
  if (!privateAddress) fail("LAN_PRIVATE_IPV4_INVALID");
  return value;
}

function validateRuntimeDir(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    resolve(value) !== value ||
    !/^\/[A-Za-z0-9_./-]+$/u.test(value)
  ) {
    fail("LAN_RUNTIME_DIR_INVALID");
  }
  return value.replace(/\/+$/u, "");
}

export function lanUrls(ip) {
  const address = validatePrivateIpv4(ip);
  return Object.freeze({
    ca: `http://${address}:9080/family-ai-preview-ca.crt`,
    root: `https://${address}:9443/`,
    admin: `https://${address}:9443/admin/`,
    member: `https://${address}:9443/member/`
  });
}

export function privateIpv4FromRoute(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] === null ||
    typeof value[0] !== "object" ||
    Array.isArray(value[0])
  ) {
    fail("LAN_ROUTE_INVALID");
  }
  try {
    return validatePrivateIpv4(value[0].prefsrc);
  } catch {
    fail("LAN_ROUTE_INVALID");
  }
}

export function renderLeafExtensions(ip) {
  const address = validatePrivateIpv4(ip);
  return [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=IP:${address}`,
    ""
  ].join("\n");
}

export function renderNginxConfig({ ip, runtimeDir }) {
  validatePrivateIpv4(ip);
  const runtime = validateRuntimeDir(runtimeDir);
  return `pid ${runtime}/run/lan-nginx.pid;
error_log ${runtime}/logs/lan-nginx-error.log notice;
worker_processes 1;

events {
  worker_connections 256;
}

http {
  access_log off;
  server_tokens off;
  client_max_body_size 2m;

  server {
    listen 0.0.0.0:9080;

    location = /family-ai-preview-ca.crt {
      alias ${runtime}/lan-tls/ca.crt;
      default_type application/x-x509-ca-cert;
      add_header Cache-Control "no-store";
      add_header X-Content-Type-Options "nosniff";
    }

    location / {
      return 404;
    }
  }

  server {
    listen 0.0.0.0:9443 ssl;
    ssl_certificate ${runtime}/lan-tls/server.crt;
    ssl_certificate_key ${runtime}/lan-tls/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache off;

    location = / {
      return 302 /admin/;
    }

    location / {
      proxy_pass http://127.0.0.1:8791;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For "";
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 1h;
    }
  }
}
`;
}

export function validateTlsMetadata(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("LAN_TLS_METADATA_INVALID");
  }
  const now = input.now;
  const caExpiry = Date.parse(input.caNotAfter);
  const leafExpiry = Date.parse(input.leafNotAfter);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(caExpiry) ||
    !Number.isFinite(leafExpiry) ||
    validatePrivateIpv4(input.ip) !== input.leafSanIp
  ) {
    fail("LAN_TLS_METADATA_INVALID");
  }
  const caRemainingMs = caExpiry - now;
  const leafRemainingMs = leafExpiry - now;
  if (
    caRemainingMs < DAY_MS ||
    caRemainingMs > 366 * DAY_MS ||
    leafRemainingMs < 60 * 60 * 1000 ||
    leafRemainingMs > 31 * DAY_MS
  ) {
    fail("LAN_TLS_METADATA_INVALID");
  }
  return { caRemainingMs, leafRemainingMs };
}

function main(argv) {
  if (argv.length === 3 && argv[0] === "--render-nginx") {
    process.stdout.write(renderNginxConfig({ ip: argv[1], runtimeDir: argv[2] }));
    return;
  }
  if (argv.length === 2 && argv[0] === "--leaf-extensions") {
    process.stdout.write(renderLeafExtensions(argv[1]));
    return;
  }
  if (argv.length === 2 && argv[0] === "--urls") {
    process.stdout.write(`${JSON.stringify(lanUrls(argv[1]))}\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--route-ip") {
    let route;
    try {
      route = JSON.parse(argv[1]);
    } catch {
      fail("LAN_ROUTE_INVALID");
    }
    process.stdout.write(`${privateIpv4FromRoute(route)}\n`);
    return;
  }
  fail("LAN_LIBRARY_ARGUMENTS_INVALID");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write("LAN_LIBRARY_FAILED\n");
    process.exitCode = 1;
  }
}
