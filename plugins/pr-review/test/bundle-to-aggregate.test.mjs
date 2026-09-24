import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../lib/bundle.mjs';

// Der eine Test, der buildBundle und die Aggregation ZUSAMMEN durchlaeuft. Beide
// Fixture-Bundles (A und B) legen files/, patches/ und meta.json selbst an -- fuer ihren
// Zweck richtig, aber damit hat nie ein echt GEHOLTES Bundle die Aggregation gespeist,
// und genau diese Bauart hat hier schon einmal eine Grenze verdeckt (die Abnahme-Fixture
// schrieb die Ergebnisdateien selbst und lief hinter der Schreibrecht-Grenze vorbei).
// Hier baut der echte Bau-Code das Bundle aus einem gestubbten GitHub-API, und die echte
// CLI liest es: jede Naht zwischen fetchInto, loadBundle, Haystack-Bau, commentable-Map
// und Validator liegt im Pfad. Testeigene Artefakte sind nur die API-Antworten und die
// findings-Dateien -- Letztere sind der Output der Analysten, also genau die Eingabe,
// die post im Ernstfall vorfindet.

const REPO = 'example/demo';
const HEAD = 'head1';

const SERVICE_PATH = 'src/main/java/app/OrderService.java';
const SERVICE_LINES = [
  'package app;',
  '',
  'import java.util.HashMap;',
  'import java.util.Map;',
  '',
  'public class OrderService {',
  '  private final Map<String, Order> cache = new HashMap<>();',
  '  Order load(String id) {',
  '    return cache.get(id);',
  '  }',
  '}',
];
const SERVICE_PATCH = `@@ -0,0 +1,${SERVICE_LINES.length} @@\n${SERVICE_LINES.map((l) => `+${l}`).join('\n')}`;

const TEST_PATH = 'src/test/java/app/OrderServiceTest.java';
const TEST_LINES_NEW = [
  'package app;',
  '',
  'class OrderServiceTest {',
  '  void rejectsExpiredOrder() {',
  '    assertTrue(true);',
  '  }',
  '}',
];
// Die entfernte Assertion existiert am head_sha nicht mehr -- ihr Zitat lebt NUR im
// Patch. Ohne die LEFT-Strecke durch das echte Hunk-Parsing waere dieser Test blind
// fuer genau die Klasse, die schon einmal grundlos aufgeloest worden waere.
const TEST_PATCH = [
  '@@ -1,7 +1,7 @@',
  ' package app;',
  ' ',
  ' class OrderServiceTest {',
  '   void rejectsExpiredOrder() {',
  '-    assertEquals(REJECTED, service.handle(expired));',
  '+    assertTrue(true);',
  '   }',
  ' }',
].join('\n');

function b64(text) {
  return { encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') };
}

function notFound() {
  const e = new Error('gh api failed: HTTP 404');
  e.status = 404;
  return e;
}

// Das gestubbte GitHub-API: genau die Endpunkte, die fetchInto aufruft. Alles
// Unbekannte antwortet 404 -- so wie gh es taete -- damit ein neuer Abruf im Bau-Code
// hier sichtbar scheitert statt still einen leeren Wert zu bekommen.
function fakeGhApi(endpoint) {
  const routes = new Map([
    [`/repos/${REPO}/pulls/42`, {
      title: 'Aufraeumarbeiten am Auftragsdienst',
      body: 'kein Spec-Link',
      user: { login: 'agent' },
      labels: [],
      base: { sha: 'base1' },
      head: { sha: HEAD, ref: 'chore/cleanup' },
    }],
    [`/repos/${REPO}/pulls/42/files`, [
      { filename: SERVICE_PATH, status: 'added', additions: SERVICE_LINES.length, deletions: 0, patch: SERVICE_PATCH },
      { filename: TEST_PATH, status: 'modified', additions: 1, deletions: 1, patch: TEST_PATCH },
    ]],
    [`/repos/${REPO}/contents/${SERVICE_PATH}?ref=${HEAD}`, b64(`${SERVICE_LINES.join('\n')}\n`)],
    [`/repos/${REPO}/contents/${TEST_PATH}?ref=${HEAD}`, b64(`${TEST_LINES_NEW.join('\n')}\n`)],
    [`/repos/${REPO}/contents/src/main/java/app?ref=${HEAD}`, []],
    [`/repos/${REPO}/contents/src/test/java/app?ref=${HEAD}`, []],
    [`/repos/${REPO}/pulls/42/comments`, []],
  ]);
  if (routes.has(endpoint)) return Promise.resolve(routes.get(endpoint));
  return Promise.reject(notFound());
}

test('ein echt gebautes Bundle speist die Aggregation', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-b2a-')), 'bundle');
  const summary = await buildBundle({ repo: REPO, number: 42, ghApi: fakeGhApi, bundleDir: dir });

  // Vorbedingungen aus dem Bau selbst -- nichts davon hat der Test geschrieben.
  assert.equal(summary.files, 2);
  assert.equal(summary.specLink, null);
  assert.deepEqual(summary.missingTests, []);
  assert.ok(existsSync(join(dir, 'patches', `${TEST_PATH}.patch`)));

  // Der Output zweier Analysten, so wie post ihn im Ernstfall vorfindet. Drei echte
  // Befunde plus einer mit erfundener Evidenz -- der Validator muss ihn auf dem echt
  // gebauten Haystack verwerfen, nicht auf einem handgelegten.
  writeFileSync(join(dir, 'findings', 'gate-integrity.json'), JSON.stringify([
    {
      file: TEST_PATH, line: 5, side: 'LEFT', severity: 'major',
      title: 'Fachliche Assertion entfernt',
      problem: 'Die Assertion gegen REJECTED ist ersatzlos entfernt.',
      evidence: 'assertEquals(REJECTED, service.handle(expired));',
      fix: 'Stelle die Assertion wieder her.', confidence: 'high',
    },
    {
      file: TEST_PATH, line: 5, side: 'RIGHT', severity: 'major',
      title: 'Tautologie statt Pruefung',
      problem: 'assertTrue(true) kann nicht fehlschlagen.',
      evidence: 'assertTrue(true);',
      fix: 'Ersetze die Tautologie durch eine fachliche Assertion.', confidence: 'high',
    },
  ], null, 2));
  writeFileSync(join(dir, 'findings', 'test-substance.json'), JSON.stringify([
    {
      file: TEST_PATH, line: 5, side: 'RIGHT', severity: 'major',
      title: 'Test prueft nichts mehr',
      problem: 'Keine Aenderung am Produktivcode macht diesen Test rot.',
      evidence: 'assertTrue(true);',
      fix: 'Pruefe das Verhalten von handle() fuer abgelaufene Auftraege.', confidence: 'high',
    },
    {
      file: SERVICE_PATH, line: 7, side: 'RIGHT', severity: 'major',
      title: 'Erfundene Evidenz',
      problem: 'Dieses Zitat steht nirgends im Bundle.',
      evidence: 'this.cache = new WeakHashMap<>();',
      fix: 'Darf nie gepostet werden.', confidence: 'high',
    },
  ], null, 2));

  const skipped = ['consistency', 'java-spring', 'rationale', 'security-context',
    'spec-fidelity', 'vue-ts', 'workflow-ci']
    .map((n) => `${n}:im Integrationstest nicht gestartet`).join(',');
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'lib/cli.mjs'),
    'post', '--bundle', dir, '--dry-run', '--skipped', skipped], {
    encoding: 'utf8',
    cwd: mkdtempSync(join(tmpdir(), 'prr-b2a-cwd-')),
  });

  const payload = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8'));
  assert.equal(payload.commit_id, HEAD);
  assert.equal(payload.event, 'COMMENT');

  // Zwei Kommentare: die LEFT-Assertion allein, die Tautologie als Cluster aus zwei
  // Analysten. Der erfundene Befund fehlt.
  assert.equal(payload.comments.length, 2);

  const left = payload.comments.find((c) => c.side === 'LEFT');
  assert.ok(left, 'der Befund auf der entfernten Zeile fehlt -- die Patch-Strecke ist gerissen');
  assert.equal(left.path, TEST_PATH);
  assert.equal(left.line, 5);
  assert.match(left.body, /assertEquals\(REJECTED/);

  const merged = payload.comments.find((c) => c.side === 'RIGHT');
  assert.equal(merged.path, TEST_PATH);
  assert.match(merged.body, /analysts=gate-integrity,test-substance/);
  // Beide haben die Stelle unabhaengig als major eingeordnet: die Konkordanz-Regel
  // muss auf einem echt gebauten Bundle genauso erhoehen wie auf dem Fixture.
  assert.match(merged.body, /sev=blocker/);
  assert.match(merged.body, /raised/);

  assert.match(payload.body, /Discarded: 1/);
  assert.match(payload.body, /evidence not found in the bundle/);
  assert.match(payload.body, /not started — consistency/);
});
