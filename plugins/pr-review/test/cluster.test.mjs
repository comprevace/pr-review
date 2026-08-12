import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings } from '../lib/cluster.mjs';

const A_LINES = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', '@Disabled("flaky")',
  'l11', 'assertTrue(true);', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19', 'far away'];
const haystacks = new Map([
  ['src/A.java', A_LINES.join('\n')],
  ['src/B.java', 'only one line\n'],
]);
const analystTitles = new Map([['gi', 'Gate-Integrität'], ['sf', 'Spec-Treue'], ['cx', 'Komplexität']]);
const ctx = { haystacks, analystTitles };

const f = (over) => ({
  analyst: 'gi', file: 'src/A.java', line: 10, start_line: null, side: 'RIGHT',
  severity: 'major', baseSeverity: 'major', title: 't', problem: 'p',
  evidence: '@Disabled("flaky")', fix: 'x', confidence: 'hoch', ...over,
});

// Wichtig fuer die naechsten zwei Tests: problem und fix muessen sich unterscheiden.
// Zwei Analysten mit disjunkten Blickrichtungen sagen am selben Ort normalerweise
// VERSCHIEDENE Dinge -- genau dafuer gibt es das Roster. Waeren ihre Texte gleich,
// griffe dedupeItems und legte sie zu einem Eintrag zusammen (das ist der Fall, den
// der Test "identische Auftraege werden entdoppelt" abdeckt), womit items.length 1
// und tension false waere.
const zwei = () => [
  f({ analyst: 'gi', line: 10, problem: 'Test stillgelegt', fix: 'Annotation entfernen.' }),
  f({ analyst: 'sf', line: 12, evidence: 'assertTrue(true);', problem: 'Kriterium ohne Absicherung', fix: 'Zeitgrenze pruefen.' }),
];

test('zwei Analysten innerhalb der Toleranz bilden ein Cluster mit beiden Tags', () => {
  const out = clusterFindings(zwei(), ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].items.length, 2);
  assert.equal(out[0].items[0].analystTitle, 'Gate-Integrität');
});

test('Overlap eskaliert die Severity um eine Stufe und merkt sich den Grund', () => {
  const out = clusterFindings(zwei(), ctx);
  assert.equal(out[0].baseSeverity, 'major');
  assert.equal(out[0].severity, 'blocker');
  assert.equal(out[0].escalated, true);
  assert.equal(out[0].tension, true);
});

test('Abstand ueber der Toleranz bleibt getrennt', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10 }),
    f({ analyst: 'sf', line: 20, evidence: 'far away' }),
  ], ctx);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.escalated === false));
});

test('derselbe Analyst zweimal eskaliert nicht', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10 }),
    f({ analyst: 'gi', line: 12, evidence: 'assertTrue(true);', title: 'zweiter', problem: 'anders', fix: 'anders' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi']);
  assert.equal(out[0].escalated, false);
  assert.equal(out[0].tension, false);
});

test('info wird nie eskaliert', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, severity: 'info' }),
    f({ analyst: 'sf', line: 12, severity: 'info', evidence: 'assertTrue(true);' }),
  ], ctx);
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].escalated, false);
});

test('ein Leerzeichen im Dateipfad zerlegt das Cluster nicht', () => {
  // Der Gruppenschluessel besteht aus Pfad und Seite. Waere das Trennzeichen ein
  // Leerzeichen, faellt "src/my file.java RIGHT" beim Zurueckzerlegen in drei
  // Teile und die Datei hiesse danach "src/my" -- der Kommentar landete an einem
  // Pfad, den es nicht gibt, und die API lehnte das ganze Review ab.
  const h = new Map([['src/my file.java', 'nur eine Zeile\n']]);
  const out = clusterFindings(
    [f({ file: 'src/my file.java', line: 1, evidence: 'nur eine Zeile' })],
    { haystacks: h, analystTitles },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'src/my file.java');
  assert.equal(out[0].side, 'RIGHT');
});

test('verschiedene Dateien und Seiten werden nie zusammengelegt', () => {
  const out = clusterFindings([
    f({ file: 'src/A.java', line: 10 }),
    f({ analyst: 'sf', file: 'src/B.java', line: 1, evidence: 'only one line' }),
    f({ analyst: 'cx', file: 'src/A.java', line: 10, side: 'LEFT', severity: 'minor' }),
  ], ctx);
  assert.equal(out.length, 3);
});

test('identische Auftraege werden entdoppelt, Tags bleiben erhalten', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, fix: 'Annotation entfernen.', problem: 'gleich' }),
    f({ analyst: 'sf', line: 11, fix: '  annotation   ENTFERNEN. ', problem: 'gleich', evidence: 'l11' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].items.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].escalated, true);
  assert.equal(out[0].tension, false); // entdoppelt -> keine konkurrierenden Auftraege
});

test('Cluster-ID stammt vom schwersten Item und ist unabhaengig von der Eingabereihenfolge', () => {
  const first = f({ analyst: 'gi', line: 10, severity: 'minor' });
  const second = f({ analyst: 'sf', line: 12, severity: 'blocker', evidence: 'assertTrue(true);', problem: 'x2', fix: 'y2' });
  const a = clusterFindings([first, second], ctx);
  const b = clusterFindings([second, first], ctx);
  assert.equal(a[0].id, b[0].id);
  assert.match(a[0].id, /^[0-9a-f]{6}$/);
});

test('Rueckgabe ist nach Severity sortiert', () => {
  const out = clusterFindings([
    f({ analyst: 'cx', file: 'src/B.java', line: 1, severity: 'minor', evidence: 'only one line' }),
    f({ analyst: 'gi', line: 10, severity: 'major' }),
    f({ analyst: 'sf', line: 12, severity: 'major', evidence: 'assertTrue(true);', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out[0].severity, 'blocker'); // eskaliert aus dem Doppelbefund
  assert.equal(out[1].severity, 'minor');
});

test('start_line deckt den ganzen Cluster ab', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 12, start_line: 10 }),
    f({ analyst: 'sf', line: 13, evidence: 'l13', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out[0].start_line, 10);
  assert.equal(out[0].line, 13);
});
