import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const notObserved = 'not-observed';
const knownProviderImages = new Map([
  [
    'sha256:00d6a37fd5ec8e35e85eeb0e70eb5d856647e1452afff01f9ba98b94d6ae7ce7',
    ['fake'],
  ],
]);
const forbiddenKey = /authorization|bearer|token|secret|credential|cookie|upstreambody|stack/i;
const forbiddenValue = /\bBearer\s+[A-Za-z0-9._~+\/-]+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 3000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function dockerInspect(container, template) {
  return run('docker', ['inspect', '--format', template, container]);
}

function imageInspect(image, label) {
  return run('docker', [
    'image', 'inspect', '--format',
    `{{index .Config.Labels ${JSON.stringify(label)}}}`,
    image,
  ]);
}

function httpStatus(baseUrl, path) {
  const output = run('curl', [
    '--silent', '--show-error', '--max-time', '2',
    '--output', '/dev/null', '--write-out', '%{http_code}',
    `${baseUrl}${path}`,
  ], { timeout: 3500 });
  return output && /^\d{3}$/.test(output) ? Number(output) : notObserved;
}

function routeCapability(status) {
  if (typeof status !== 'number') return notObserved;
  return status !== 404;
}

async function attachmentSummary(runtimeRoot) {
  if (!runtimeRoot || runtimeRoot === notObserved) {
    return { state: notObserved, permissions: notObserved, fileCount: notObserved };
  }
  const root = join(runtimeRoot, 'attachments');
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return { state: 'absent', permissions: notObserved, fileCount: 0 };
    }
    let count = 0;
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop();
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(join(directory, entry.name));
        else if (entry.isFile()) count += 1;
      }
    }
    return {
      state: 'present',
      permissions: (rootStat.mode & 0o777).toString(8).padStart(4, '0'),
      fileCount: count,
    };
  } catch {
    return { state: 'absent', permissions: notObserved, fileCount: 0 };
  }
}

function schemaVersion(runtimeRoot) {
  if (!runtimeRoot || runtimeRoot === notObserved) return notObserved;
  const database = join(runtimeRoot, 'gateway.sqlite');
  const value = run('sqlite3', [
    `file:${database}?mode=ro`,
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;',
  ]);
  return value && /^\d+$/.test(value) ? Number(value) : notObserved;
}

function systemdState(user) {
  const args = user
    ? ['--user', 'is-active', 'family-ai-gateway.service']
    : ['is-active', 'family-ai-gateway.service'];
  const result = spawnSync('systemctl', args, {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 4096,
  });
  const state = result.stdout.trim();
  return /^(active|inactive|failed|activating|deactivating)$/.test(state)
    ? state
    : notObserved;
}

function assertSafe(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && forbiddenValue.test(value)) fail('RUNTIME_TRUTH_UNSAFE_VALUE');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(key)) fail('RUNTIME_TRUTH_UNSAFE_FIELD');
    assertSafe(item, `${path}.${key}`);
  }
}

const topLevelKeys = [
  'observedAt', 'listener', 'listenerState', 'owner', 'image', 'runtime',
  'attachments', 'routes', 'providers', 'systemd', 'capabilities',
];

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('RUNTIME_TRUTH_NOT_OBJECT');
  }
  const keys = Object.keys(input).sort();
  if (keys.join('\0') !== [...topLevelKeys].sort().join('\0')) {
    fail('RUNTIME_TRUTH_FIELDS_INVALID');
  }
  assertSafe(input);
  if (!Number.isFinite(Date.parse(input.observedAt))) fail('RUNTIME_TRUTH_TIME_INVALID');
  return Object.fromEntries(topLevelKeys.map((key) => [key, input[key]]));
}

async function liveReport(host, port) {
  const listener = `${host}:${port}`;
  const baseUrl = `http://${listener}`;
  const listenerRows = run('ss', ['-H', '-ltnp', `sport = :${port}`]);
  const listenerState = listenerRows?.includes(listener) ? 'observed' : notObserved;
  const healthStatus = httpStatus(baseUrl, '/health');

  const dockerRows = run('docker', [
    'ps', '--filter', `publish=${port}`, '--format', '{{.ID}}\t{{.Names}}',
  ]);
  const rows = dockerRows ? dockerRows.split('\n').filter(Boolean) : [];
  const [containerId, containerName] = rows.length === 1
    ? rows[0].split('\t')
    : [null, null];

  let project = notObserved;
  let service = notObserved;
  let image = notObserved;
  let sourceCommit = notObserved;
  let restartCount = notObserved;
  let createdAt = notObserved;
  let startedAt = notObserved;
  let runtimeRoot = notObserved;
  let containerHealth = notObserved;
  if (containerId) {
    project = dockerInspect(containerId, '{{index .Config.Labels "com.docker.compose.project"}}') || notObserved;
    service = dockerInspect(containerId, '{{index .Config.Labels "com.docker.compose.service"}}') || notObserved;
    image = dockerInspect(containerId, '{{.Image}}') || notObserved;
    restartCount = dockerInspect(containerId, '{{.RestartCount}}') || notObserved;
    createdAt = dockerInspect(containerId, '{{.Created}}') || notObserved;
    startedAt = dockerInspect(containerId, '{{.State.StartedAt}}') || notObserved;
    runtimeRoot = dockerInspect(
      containerId,
      '{{range .Mounts}}{{if eq .Destination "/app/.runtime/data"}}{{.Source}}{{end}}{{end}}',
    ) || notObserved;
    containerHealth = dockerInspect(containerId, '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}') || notObserved;
    sourceCommit = image === notObserved
      ? notObserved
      : imageInspect(image, 'org.opencontainers.image.revision') || 'unknown';
  }

  const routes = {
    root: httpStatus(baseUrl, '/'),
    member: httpStatus(baseUrl, '/member/'),
    admin: httpStatus(baseUrl, '/admin/'),
    memberEntryContext: httpStatus(baseUrl, '/api/v1/member/entry/context'),
  };
  const attachments = await attachmentSummary(runtimeRoot);
  const runtimeSchema = schemaVersion(runtimeRoot);
  const providers = knownProviderImages.get(image) ?? [notObserved];

  return normalize({
    observedAt: new Date().toISOString(),
    listener,
    listenerState,
    owner: {
      kind: containerId
        ? (project === notObserved ? 'docker' : 'docker-compose')
        : 'unknown',
      project,
      service,
      container: containerName || notObserved,
    },
    image: { id: image, sourceCommit },
    runtime: {
      schemaVersion: runtimeSchema,
      restartCount: /^\d+$/.test(String(restartCount)) ? Number(restartCount) : notObserved,
      health: healthStatus === 200
        ? (containerHealth === 'unhealthy' ? 'unhealthy' : 'healthy')
        : (healthStatus === notObserved ? notObserved : 'unhealthy'),
      createdAt,
      startedAt,
    },
    attachments,
    routes,
    providers,
    systemd: {
      system: systemdState(false),
      user: systemdState(true),
    },
    capabilities: {
      memberWeb: routeCapability(routes.member),
      adminWeb: routeCapability(routes.admin),
      attachments: attachments.state === 'present'
        ? true
        : (attachments.state === 'absent' ? false : notObserved),
      hermesProvider: providers.includes('hermes') ? true : (providers[0] === notObserved ? notObserved : false),
      codexProvider: providers.includes('codex') ? true : (providers[0] === notObserved ? notObserved : false),
    },
  });
}

const [mode, first, second] = process.argv.slice(2);
let report;
if (mode === '--fixture') {
  if (!first || second) fail('RUNTIME_TRUTH_ARGUMENTS_INVALID');
  try {
    report = normalize(JSON.parse(await readFile(first, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('RUNTIME_TRUTH_FIXTURE_MISSING');
    throw error;
  }
} else if (mode === '--live') {
  if (first !== '127.0.0.1' || !/^\d+$/.test(second ?? '')) {
    fail('RUNTIME_TRUTH_ARGUMENTS_INVALID');
  }
  report = await liveReport(first, Number(second));
} else {
  fail('RUNTIME_TRUTH_ARGUMENTS_INVALID');
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
