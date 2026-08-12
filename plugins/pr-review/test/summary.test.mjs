import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary } from '../lib/summary.mjs';

const base = {
  pluginVersion: '0.1.0',
  analystsRun: ['gate-integrity', 'spec-fidelity'],
  analystsSkipped: [{ name: 'java-spring', reason: 'kein Pfad im Diff passt auf **/*.java' }],
  analystsFailed: [],
  counts: { blocker: 1, major: 2, minor: 0, info: 0 },
  rejected: [{ analyst: 'gate-integrity', title: 'Erfunden', reason: 'Evidenz im Bundle nicht auffindbar' }],
  anchorless: [{ file: 'src/A.java', line: 99, severity: 'major', items: [{ title: 'Ausserhalb' }] }],
  capped: [],
  skippedExisting: [],
  verify: null,
  meta: { spec_missing: false, conventions_missing: false, missing_tests: [] },
};

test('Bilanz nennt gelaufene, uebersprungene und ausgefallene Analysten', () => {
  const s = renderSummary({ ...base, analystsFailed: [{ name: 'spec-fidelity', reason: 'ungueltiges JSON' }] });
  assert.match(s, /gate-integrity/);
  assert.match(s, /java-spring/);
  assert.match(s, /kein Pfad im Diff/);
  assert.match(s, /spec-fidelity.*ungueltiges JSON|ungueltiges JSON/s);
});

test('Bilanz zaehlt Befunde je Severity', () => {
  const s = renderSummary(base);
  assert.match(s, /blocker.*1/s);
  assert.match(s, /major.*2/s);
});

test('verworfene Befunde werden mit Grund gezaehlt, nie still gekappt', () => {
  const s = renderSummary(base);
  assert.match(s, /Evidenz im Bundle nicht auffindbar/);
  assert.match(s, /1/);
});

test('ankerlose Befunde stehen mit Datei und Zeile in der Bilanz', () => {
  const s = renderSummary(base);
  assert.match(s, /src\/A\.java:99/);
  assert.match(s, /Ausserhalb/);
});

test('Kappung nennt die Zahl und den Hinweis zur PR-Groesse', () => {
  const s = renderSummary({ ...base, capped: [{ file: 'a', line: 1, severity: 'minor', items: [{ title: 'x' }] }] });
  assert.match(s, /zu groß/);
});

test('fehlende Spec und fehlende Tests werden benannt', () => {
  const s = renderSummary({ ...base, meta: { spec_missing: true, conventions_missing: true, missing_tests: ['src/A.java'] } });
  assert.match(s, /Spec/);
  assert.match(s, /CLAUDE\.md/);
  assert.match(s, /src\/A\.java/);
});

test('Zweitlauf-Bilanz erscheint nur mit verify-Daten', () => {
  assert.doesNotMatch(renderSummary(base), /behoben/);
  const s = renderSummary({ ...base, verify: { resolved: 7, stillOpen: 2, fresh: 1 } });
  assert.match(s, /7 .*behoben/);
  assert.match(s, /2 .*offen/);
  assert.match(s, /1 .*neu/);
});

test('Jede Bilanz sagt, dass dies kein Gate ist, und nennt die Version', () => {
  const s = renderSummary(base);
  assert.match(s, /Signal/);
  assert.match(s, /kein Gate/);
  assert.match(s, /Approve/);
  assert.match(s, /0\.1\.0/);
});

test('Der Osmani-Block steht in jeder Bilanz', () => {
  const s = renderSummary(base);
  assert.match(s, /Was hat sich geändert/);
  assert.match(s, /Warum ist es sicher/);
  assert.match(s, /wenn wir uns irren/);
});
