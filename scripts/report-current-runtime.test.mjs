import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const script = new URL('./report-current-runtime.sh', root);
const fixture = (name) => new URL(`./fixtures/runtime-truth/${name}.json`, root);

function reportWithFixture(name) {
  const result = spawnSync('bash', [script.pathname], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAMILY_AI_RUNTIME_TRUTH_FIXTURE: fixture(name).pathname,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('reports the formal V3 Fake-only fixture without upgrading its facts', () => {
  const report = reportWithFixture('formal-v3');
  assert.equal(report.runtime.schemaVersion, 3);
  assert.equal(report.owner.project, 'family-ai-platform-foundation');
  assert.deepEqual(report.providers, ['fake']);
  assert.deepEqual(report.capabilities, {
    memberWeb: false,
    adminWeb: false,
    attachments: false,
    hermesProvider: false,
    codexProvider: false,
  });
});

test('reports candidate V9 capabilities only when fixture evidence contains them', () => {
  const report = reportWithFixture('candidate-v9');
  assert.equal(report.runtime.schemaVersion, 9);
  assert.equal(report.capabilities.memberWeb, true);
  assert.equal(report.capabilities.attachments, true);
  assert.deepEqual(report.providers, ['fake', 'hermes', 'codex']);
});

test('returns stable not-observed values when runtime tools are unavailable', () => {
  const report = reportWithFixture('not-observed');
  assert.equal(report.listenerState, 'not-observed');
  assert.equal(report.runtime.health, 'not-observed');
  assert.equal(report.capabilities.memberWeb, 'not-observed');
});

test('rejects credential-like fixture fields and never echoes their values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'family-runtime-truth-'));
  const path = join(directory, 'unsafe.json');
  try {
    const safe = JSON.parse(await readFile(fixture('not-observed'), 'utf8'));
    safe.Authorization = 'Bearer should-never-appear';
    await writeFile(path, JSON.stringify(safe), { mode: 0o600 });
    const result = spawnSync('bash', [script.pathname], {
      encoding: 'utf8',
      env: { ...process.env, FAMILY_AI_RUNTIME_TRUTH_FIXTURE: path },
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /should-never-appear/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
