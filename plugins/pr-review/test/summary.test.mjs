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

test('eine gekappte Nachbarschaft steht in der Bilanz, nicht nur in meta.json', () => {
  // Nichts scheitert still. Wurde die Nachbarschaft abgeschnitten, hat consistency nur
  // einen Ausschnitt des Verzeichnisses gesehen -- und "kein Musterbruch gefunden" ist
  // dann keine Aussage ueber das Verzeichnis, sondern ueber acht Dateien daraus. Wer das
  // nicht erfaehrt, liest die Bilanz vollstaendiger, als sie ist.
  const s = renderSummary({ ...base, meta: { ...base.meta, siblings_truncated: ['src/main/java/app'] } });
  assert.match(s, /Nachbarschaft/);
  assert.match(s, /src\/main\/java\/app/);
  assert.doesNotMatch(renderSummary(base), /Nachbarschaft/);
});

test('Zweitlauf-Bilanz erscheint nur mit verify-Daten', () => {
  assert.doesNotMatch(renderSummary(base), /behoben/);
  const s = renderSummary({ ...base, verify: { resolved: 7, stillOpen: 2, fresh: 1 } });
  assert.match(s, /7 .*behoben/);
  assert.match(s, /2 .*offen/);
  assert.match(s, /1 .*neu/);
});

test('ein Rueckfall bekommt eine eigene, fette Zeile', () => {
  // Ein Befund, dessen Thread schon einmal aufgeloest war und der wieder gemeldet wird,
  // ist das Interessanteste, was ein Zweitlauf findet. Er darf nicht leiser sein als ein
  // neuer Befund -- und ohne Rueckfaelle steht die Zeile nicht da.
  const ohne = renderSummary({ ...base, verify: { resolved: 1, stillOpen: 0, fresh: 0, regressed: 0 } });
  assert.doesNotMatch(ohne, /Rückfall/);
  const mit = renderSummary({ ...base, verify: { resolved: 1, stillOpen: 0, fresh: 0, regressed: 2 } });
  assert.match(mit, /\*\*⚠ Rückfall: 2 Befunde waren/);
  assert.match(mit, /wieder da/);
  // Aeltere Aufrufer ohne das Feld bleiben lesbar, statt "undefined" zu drucken.
  const alt = renderSummary({ ...base, verify: { resolved: 1, stillOpen: 0, fresh: 0 } });
  assert.doesNotMatch(alt, /Rückfall|undefined/);
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
