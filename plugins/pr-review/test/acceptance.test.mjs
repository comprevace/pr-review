import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBundleA } from './fixtures/make-bundle-a.mjs';
import { loadBundle } from '../lib/bundle.mjs';
import { loadAnalysts } from '../lib/registry.mjs';
import { aggregate } from '../lib/cli.mjs';

const ROOT = join(import.meta.dirname, '..');

function readFindings(dir) {
  return new Map([
    ['gate-integrity', JSON.parse(readFileSync(join(dir, 'findings/gate-integrity.json'), 'utf8'))],
    ['spec-fidelity', JSON.parse(readFileSync(join(dir, 'findings/spec-fidelity.json'), 'utf8'))],
  ]);
}

function freshBundle(prefix) {
  return makeBundleA(join(mkdtempSync(join(tmpdir(), prefix)), 'bundle-a'));
}

function run(dir = freshBundle('prr-acc-')) {
  return aggregate({
    bundle: loadBundle(dir),
    analysts: loadAnalysts([join(ROOT, 'analysts')]),
    analystFindings: readFindings(dir),
    failed: [],
    cap: 25,
    pluginVersionString: '0.1.0',
  });
}

test('lib/cli.mjs laesst sich importieren, ohne den Prozess zu beenden', () => {
  // Diese Datei ist Modul UND Programm. Laeuft ihr Dispatcher schon beim Import,
  // faellt er ohne Subkommando in den else-Zweig, ruft fail() und beendet den
  // Testprozess -- alle Tests dieser Datei waeren dann tot, bevor einer startet.
  // Dass dieser Test ueberhaupt zur Ausfuehrung kommt, ist der halbe Beweis; die
  // Zusicherung haelt den Import zusaetzlich gegen ein spaeteres Umbenennen fest.
  assert.equal(typeof aggregate, 'function');
});

test('Fall A+B: ein Kommentar, zwei Tags, Severity auf blocker erhoeht', () => {
  const result = run();
  assert.equal(result.comments.length, 1, 'genau ein Inline-Kommentar erwartet');
  const cluster = result.report.posted[0];
  assert.equal(cluster.file, 'src/A.java');
  assert.deepEqual(cluster.analysts.slice().sort(), ['gate-integrity', 'spec-fidelity']);
  assert.equal(cluster.baseSeverity, 'major');
  assert.equal(cluster.severity, 'blocker');
  assert.equal(cluster.escalated, true);
  const body = result.comments[0].body;
  assert.match(body, /blocker/);
  assert.match(body, /`Gate-Integrität` \+ `Spec-Treue`/);
  assert.match(body, /von major erhöht/);
  assert.match(body, /@Disabled\("flaky"\)/);
  assert.match(body, /assertTrue\(true\);/);
});

test('Fall C: Befund ausserhalb der Hunks landet in der Bilanz, nicht am Code', () => {
  const result = run();
  assert.equal(result.report.anchorless.length, 1);
  assert.equal(result.report.anchorless[0].file, 'src/B.java');
  assert.equal(result.report.anchorless[0].line, 17);
  assert.match(result.body, /src\/B\.java:17/);
  assert.ok(!result.comments.some((c) => c.path === 'src/B.java'));
});

test('Fall D: Befund ohne auffindbare Evidenz wird verworfen UND gezaehlt', () => {
  const result = run();
  assert.ok(!JSON.stringify(result.comments).includes('Erfundener Befund'));
  assert.match(result.body, /Verworfen: 1/);
  assert.match(result.body, /Evidenz im Bundle nicht auffindbar/);
});

test('aggregate gibt die verworfenen Befunde heraus, nicht nur in seine eigene Bilanz', () => {
  // Der Zweitlauf baut seine Bilanz selbst und kann die Liste nur verwenden, wenn
  // aggregate sie herausgibt. Vorher schloss sie nur renderBody ein: jeder verworfene
  // Befund eines Zweitlaufs verschwand samt Grund und Analystennamen aus der Bilanz.
  const result = run();
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].analyst, 'spec-fidelity');
  assert.equal(result.rejected[0].reason, 'Evidenz im Bundle nicht auffindbar');
});

test('das Review ist ein Kommentar, niemals ein Approve', () => {
  const result = run();
  assert.equal(result.event, 'COMMENT');
  assert.match(result.body, /Signal.*kein Gate|kein Gate/s);
  assert.match(result.body, /kein Approve/);
});

test('die Bilanz nennt das Analystenpaar, das sich ins Gehege kam', () => {
  // Die Integrationsprobe zum Overlap-Block: nicht nur, dass renderSummary ihn setzen
  // KANN, sondern dass aggregate ihn aus den echten Clustern speist. Fall A+B ist der
  // gepflanzte Doppelbefund dieses Bundles.
  const result = run();
  assert.match(result.body, /Mehrfachbefunde/);
  assert.match(result.body, /gate-integrity \+ spec-fidelity/);
});

test('jeder Kommentar traegt einen maschinenlesbaren Marker', () => {
  const result = run();
  for (const comment of result.comments) {
    assert.match(comment.body, /<!-- pr-review:v2 id=[0-9a-f]{6} /);
  }
});

test('ein zweiter Lauf mit denselben Befunden postet nichts doppelt', () => {
  const first = run();
  const dir = freshBundle('prr-acc2-');
  writeFileSync(
    join(dir, 'previous.json'),
    JSON.stringify(first.comments.map((c) => ({ body: c.body })), null, 2),
  );
  const second = run(dir);
  assert.equal(second.comments.length, 0);
  assert.equal(second.report.skippedExisting.length, 1);
});
