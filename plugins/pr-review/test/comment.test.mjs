import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceIndex, findingId, evidenceHash, renderMarker, parseMarker, renderComment } from '../lib/comment.mjs';

// Vorkommen in Zeile 2 und Zeile 6. Zeile 4 liegt damit genau dazwischen und
// prueft den Gleichstand wirklich -- bei Vorkommen in 2 und 5 waere Zeile 4 kein
// Gleichstand, sondern naeher an 5, und die Erwartung "erstes" waere falsch.
const FILE = ['a', '  @Disabled("flaky")', 'c', 'd', 'e', '  @Disabled("flaky")', 'g'].join('\n');

test('occurrenceIndex waehlt das Vorkommen, das der Zeile am naechsten liegt', () => {
  assert.equal(occurrenceIndex(FILE, '@Disabled("flaky")', 2), 1);
  assert.equal(occurrenceIndex(FILE, '@Disabled("flaky")', 6), 2);
  assert.equal(occurrenceIndex(FILE, '@Disabled("flaky")', 4), 1); // echter Gleichstand -> erstes
});

test('occurrenceIndex gibt 0 zurueck, wenn die Evidenz fehlt', () => {
  assert.equal(occurrenceIndex(FILE, 'gibt-es-nicht', 1), 0);
});

test('occurrenceIndex ignoriert Einrueckungsunterschiede', () => {
  assert.equal(occurrenceIndex('   x = 1;', 'x = 1;', 1), 1);
});

test('ein Vorkommen unterhalb der gemeldeten Zeile gewinnt, wenn es naeher liegt', () => {
  // Gegen die naheliegende Fehlimplementierung "erst oberhalb suchen, dann
  // unterhalb": die waehlt bei gemeldeter Zeile 84 das Vorkommen aus Zeile 10
  // statt dem aus Zeile 85. Die ID zeigte dann auf eine andere Stelle als der
  // Befund, und der Zweitlauf verglich Aepfel mit Birnen.
  const lines = Array.from({ length: 90 }, () => 'filler');
  lines[9] = '  @Disabled("x")';
  lines[84] = '  @Disabled("x")';
  assert.equal(occurrenceIndex(lines.join('\n'), '@Disabled("x")', 84), 2);
});

test('findingId ist stabil gegen Zeilenverschiebung', () => {
  const a = findingId('src/A.java', '@Disabled("flaky")', 1);
  const b = findingId('src/A.java', '  @Disabled("flaky")  ', 1);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{6}$/);
});

test('findingId unterscheidet Vorkommen und Dateien', () => {
  assert.notEqual(findingId('src/A.java', 'x', 1), findingId('src/A.java', 'x', 2));
  assert.notEqual(findingId('src/A.java', 'x', 1), findingId('src/B.java', 'x', 1));
});

test('renderMarker und parseMarker sind zueinander invers', () => {
  const marker = renderMarker({ id: 'a3f9c1', sev: 'blocker', ev: 'deadbeef', analysts: ['gate-integrity', 'spec-fidelity'] });
  assert.match(marker, /^<!-- pr-review:v1 /);
  assert.deepEqual(parseMarker(`text\n${marker}\n`), {
    id: 'a3f9c1', sev: 'blocker', ev: 'deadbeef', analysts: ['gate-integrity', 'spec-fidelity'],
  });
});

test('evidenceHash ist unabhaengig von Whitespace und im Marker lesbar', () => {
  assert.equal(evidenceHash('  x = 1;  '), evidenceHash('x = 1;'));
  assert.match(evidenceHash('x'), /^[0-9a-f]{8}$/);
  assert.equal(parseMarker(renderMarker({ id: 'aaaaaa', sev: 'major', ev: evidenceHash('x'), analysts: [] })).ev, evidenceHash('x'));
});

test('ein Marker ohne ev bleibt lesbar (Rueckwaertskompatibilitaet)', () => {
  const old = '<!-- pr-review:v1 id=aaaaaa sev=major analysts=gi -->';
  assert.deepEqual(parseMarker(old), { id: 'aaaaaa', sev: 'major', ev: null, analysts: ['gi'] });
});

test('parseMarker ignoriert fremde Kommentare', () => {
  assert.equal(parseMarker('nur ein normaler Review-Kommentar'), null);
  assert.equal(parseMarker('<!-- andere-tooling id=1 -->'), null);
});

const cluster = {
  file: 'src/A.java', side: 'RIGHT', line: 12, start_line: 10,
  severity: 'blocker', baseSeverity: 'major', escalated: true, tension: true,
  analysts: ['gate-integrity', 'spec-fidelity'], id: 'a3f9c1',
  items: [
    { analyst: 'gate-integrity', analystTitle: 'Gate-Integrität', title: 'Test stillgelegt',
      problem: 'Der Test ist abgeschaltet.', evidence: '@Disabled("flaky")',
      fix: 'Annotation entfernen.', confidence: 'hoch' },
    { analyst: 'spec-fidelity', analystTitle: 'Spec-Treue', title: 'Kriterium 3 offen',
      problem: 'Akzeptanzkriterium 3 ist nicht abgedeckt.', evidence: 'assertTrue(true);',
      fix: 'Zeitgrenze pruefen.', confidence: 'mittel' },
  ],
};

test('renderComment zeigt Severity, Tags, Eskalationsgrund und beide Auftraege', () => {
  const body = renderComment(cluster);
  assert.match(body, /\*\*🔴 blocker\*\*/);
  assert.match(body, /`Gate-Integrität` \+ `Spec-Treue`/);
  assert.match(body, /von major erhöht/);
  assert.match(body, /> `@Disabled\("flaky"\)`/);
  assert.match(body, /> `assertTrue\(true\);`/);
  assert.match(body, /\*\*Auftrag:\*\* Annotation entfernen\./);
  assert.match(body, /\*\*Auftrag:\*\* Zeitgrenze pruefen\./);
  assert.match(body, /zwei Blickrichtungen/);
  assert.ok(body.includes(renderMarker({
    id: 'a3f9c1', sev: 'blocker', ev: evidenceHash('@Disabled("flaky")'), analysts: cluster.analysts,
  })));
});

test('renderComment bei einem Analysten ohne Eskalations- und Spannungshinweis', () => {
  const single = { ...cluster, severity: 'major', escalated: false, tension: false,
    analysts: ['gate-integrity'], items: [cluster.items[0]] };
  const body = renderComment(single);
  assert.match(body, /\*\*🟠 major\*\*/);
  assert.doesNotMatch(body, /erhöht/);
  assert.doesNotMatch(body, /Blickrichtungen/);
});

test('renderComment weist niedriges Vertrauen aus', () => {
  const low = { ...cluster, items: [{ ...cluster.items[0], confidence: 'niedrig' }],
    analysts: ['gate-integrity'], tension: false, escalated: false };
  assert.match(renderComment(low), /Vertrauen: niedrig/);
});
