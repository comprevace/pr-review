import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings, overlapStats } from '../lib/cluster.mjs';
import { renderComment, parseEvidence, evidenceHash, findingId, occurrenceIndex } from '../lib/comment.mjs';

const A_LINES = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', '@Disabled("flaky")',
  'l11', 'assertTrue(true);', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19', 'far away'];
// Zweimal dasselbe Fragment in einer Datei -- das ist der Fall, den occurrenceIndex
// unterscheidet und der Gruppenschluessel deshalb auch unterscheiden muss.
const DUP_LINES = ['cache.clear();', 'x', 'y', 'z', 'cache.clear();'];

const haystacks = new Map([
  ['src/A.java', A_LINES.join('\n')],
  ['src/B.java', 'only one line\n'],
  ['src/Dup.java', DUP_LINES.join('\n')],
]);
const analystTitles = new Map([['gi', 'Gate-Integrität'], ['sf', 'Spec-Treue'], ['cx', 'Komplexität']]);
const ctx = { haystacks, analystTitles };

const f = (over) => ({
  analyst: 'gi', file: 'src/A.java', line: 10, start_line: null, side: 'RIGHT',
  severity: 'major', baseSeverity: 'major', title: 't', problem: 'p',
  evidence: '@Disabled("flaky")', fix: 'x', confidence: 'high', ...over,
});

// Wichtig fuer die Cluster-Tests: problem und fix muessen sich unterscheiden. Zwei
// Analysten mit disjunkten Blickrichtungen sagen am selben Ort normalerweise
// VERSCHIEDENE Dinge -- genau dafuer gibt es das Roster. Waeren ihre Texte gleich,
// griffe dedupeItems und legte sie zu einem Eintrag zusammen (das ist der Fall, den
// der Test "identische Auftraege werden entdoppelt" abdeckt), womit items.length 1
// und tension false waere.
const zwei = () => [
  f({ analyst: 'gi', line: 10, problem: 'Test stillgelegt', fix: 'Annotation entfernen.' }),
  f({ analyst: 'sf', line: 12, problem: 'Kriterium ohne Absicherung', fix: 'Zeitgrenze pruefen.' }),
];

test('dasselbe Zitat bildet ein Cluster mit beiden Tags, auch an verschiedenen Zeilen', () => {
  // Der Ort eines Befundes ist sein Zitat, nicht seine Zeilennummer: zwei Analysten
  // verankern dasselbe Fragment unterschiedlich (einer punktuell, einer als Bereich),
  // meinen aber dieselbe Stelle. Das ist die einzige Form von Ueberlappung, die dieses
  // Konstrukt ueberhaupt beweisen kann.
  const out = clusterFindings(zwei(), ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].items.length, 2);
  assert.equal(out[0].items[0].analystTitle, 'Gate-Integrität');
});

test('verschiedene Zitate bleiben getrennt, auch in DERSELBEN Zeile', () => {
  // Der Kern der Umstellung vom 13.08.: Zeilennaehe war der Gruppenschluessel, und bei
  // neun Analysten verschmolz damit eine ganze Dateiregion zu einem Kommentar mit
  // fuenf verschiedenen Auftraegen. Zwei Analysten, die verschiedene Fragmente zitieren,
  // haben zwei Befunde -- auch wenn beide auf Zeile 10 zeigen.
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, evidence: '@Disabled("flaky")' }),
    f({ analyst: 'sf', line: 10, evidence: 'assertTrue(true);', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.escalated === false));
  assert.ok(out.every((c) => c.analysts.length === 1));
});

test('ein langer Bereich verschmilzt die Datei nicht', () => {
  // Der gemessene Defekt, als Regressionsprobe. java-spring meldete im Messlauf einen
  // Bereich 8-25; unter Zeilennaehe kettete dieser eine Span alles von Zeile 8 bis 30
  // zu EINEM Cluster mit vier Analysten und sechs Auftraegen zusammen. Entscheidend:
  // das lag NICHT an der Toleranz. Auch mit Toleranz 0 haetten diese drei Befunde
  // gekettet, weil der Bereich selbst die Luecke ueberbrueckt (20 - 20 <= 0). Ein
  // kleinerer Regler waere also nie der Fix gewesen -- nur eine andere Achse ist es.
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, evidence: '@Disabled("flaky")' }),
    f({ analyst: 'sf', start_line: 10, line: 20, evidence: 'assertTrue(true);', problem: 'p2', fix: 'f2' }),
    f({ analyst: 'cx', line: 20, evidence: 'far away', severity: 'minor', problem: 'p3', fix: 'f3' }),
  ], ctx);
  assert.equal(out.length, 3);
  assert.ok(out.every((c) => c.analysts.length === 1));
});

test('dasselbe Zitat an verschiedenen Vorkommen bleibt getrennt', () => {
  // Zwei gleichlautende Zeilen in einer Datei sind zwei Fundstellen. Der Schluessel
  // enthaelt deshalb occurrenceIndex -- ohne ihn traegen beide Fundstellen dieselbe ID,
  // und der Zweitlauf beantwortet Bedingung (1) fuer die eine mit der Meldung der anderen.
  const out = clusterFindings([
    f({ analyst: 'gi', file: 'src/Dup.java', line: 1, evidence: 'cache.clear();' }),
    f({ analyst: 'sf', file: 'src/Dup.java', line: 5, evidence: 'cache.clear();', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id);
});

test('jedes Item eines Clusters traegt dasselbe Zitat wie die ID', () => {
  // Die tragende Zusicherung der neuen Achse. Vorher hasht die ID die Evidenz des
  // primaeren Items, waehrend die anderen Items im selben Kommentar andere Zitate
  // trugen: bei sieben Auftraegen entschied EINES von sieben Zitaten ueber die
  // Identitaet des Threads. Wurde nur dieses behoben, rotierte die ID, computeDelta
  // loeste den Thread auf und postete die Uebrigen als neuen Kommentar -- die Bilanz
  // meldete "1 behoben, 1 neu", waehrend sechs Auftraege unangetastet in der Datei
  // standen. Teilen alle Items ein Zitat, reden Bedingung (1) und (2) ueber dieselbe
  // Sache, und zwar unabhaengig von der Eingabereihenfolge.
  const leichter = f({ analyst: 'gi', line: 10, severity: 'minor', problem: 'p1', fix: 'f1' });
  const schwerer = f({ analyst: 'sf', line: 12, severity: 'major', problem: 'p2', fix: 'f2' });

  for (const eingabe of [[leichter, schwerer], [schwerer, leichter]]) {
    const c = clusterFindings(eingabe, ctx)[0];
    assert.equal(c.items.length, 2);
    assert.ok(c.items.every((i) => i.evidence === '@Disabled("flaky")'));
    const body = renderComment(c);
    const zitat = parseEvidence(body);
    assert.equal(zitat, '@Disabled("flaky")');
    assert.ok(body.includes(`ev=${evidenceHash(zitat)}`));
    assert.equal(c.id, findingId('src/A.java', zitat, occurrenceIndex(haystacks.get('src/A.java'), zitat, 10), 'RIGHT'));
  }
});

test('zwei Analysten auf der Basisstufe erhoehen um eine Stufe', () => {
  const out = clusterFindings(zwei(), ctx);
  assert.equal(out[0].baseSeverity, 'major');
  assert.equal(out[0].severity, 'blocker');
  assert.equal(out[0].escalated, true);
  assert.equal(out[0].tension, true);
});

test('ein leichterer Befund daneben erhoeht die Stufe nicht', () => {
  // Die alte Regel zaehlte Analysten, nicht Uebereinstimmung. Im Messlauf zog damit ein
  // info-Befund ("selbstgebauter Cache") einen major-Befund auf blocker, und ein
  // minor-Befund ("Methodenname") tat dasselbe am History-Endpunkt: aus roh
  // 6 blocker / 17 major / 5 minor wurden 6 blocker / 1 major, die Leiter verlor ihre
  // Ordnungsfunktion. Ein info neben einem major ist kein zweites Urteil "major" --
  // es ist ein anderes Urteil. Erhoehung verlangt zwei Analysten, die die Stelle
  // unabhaengig voneinander AUF DERSELBEN Stufe eingeordnet haben.
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, severity: 'major', problem: 'p1', fix: 'f1' }),
    f({ analyst: 'sf', line: 12, severity: 'info', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].baseSeverity, 'major');
  assert.equal(out[0].severity, 'major');
  assert.equal(out[0].escalated, false);
});

test('derselbe Analyst zweimal erhoeht nicht', () => {
  // Redundanz entsteht aus zwei Blickrichtungen, nicht aus zwei Saetzen derselben.
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, problem: 'p1', fix: 'f1' }),
    f({ analyst: 'gi', line: 12, title: 'zweiter', problem: 'anders', fix: 'anders' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi']);
  assert.equal(out[0].escalated, false);
  assert.equal(out[0].tension, false);
});

test('info wird nie erhoeht', () => {
  // Eine Beobachtung bleibt eine Beobachtung, auch wenn zwei Analysten sie machen.
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, severity: 'info', problem: 'p1', fix: 'f1' }),
    f({ analyst: 'sf', line: 12, severity: 'info', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].escalated, false);
});

test('blocker bleibt blocker', () => {
  const out = clusterFindings([
    f({ analyst: 'gi', line: 10, severity: 'blocker', problem: 'p1', fix: 'f1' }),
    f({ analyst: 'sf', line: 12, severity: 'blocker', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out[0].severity, 'blocker');
  assert.equal(out[0].escalated, false);
});

test('ein Leerzeichen im Dateipfad zerlegt das Cluster nicht', () => {
  // Der Gruppenschluessel wird aus Pfad, Zitat, Vorkommen und Seite gebildet. Waere das
  // Trennzeichen ein Leerzeichen, ergaeben ("src/my file", "x") und ("src/my", "file x")
  // denselben Schluessel -- zwei verschiedene Befunde teilten sich einen Kommentar.
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
    f({ analyst: 'sf', line: 11, fix: '  annotation   ENTFERNEN. ', problem: 'gleich' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].items.length, 1);
  assert.deepEqual(out[0].analysts, ['gi', 'sf']);
  assert.equal(out[0].escalated, true);
  assert.equal(out[0].tension, false); // entdoppelt -> keine konkurrierenden Auftraege
});

test('die Cluster-ID haengt nicht an der Eingabereihenfolge', () => {
  const a = f({ analyst: 'gi', line: 10, severity: 'minor', problem: 'p1', fix: 'f1' });
  const b = f({ analyst: 'sf', line: 12, severity: 'blocker', problem: 'p2', fix: 'f2' });
  const x = clusterFindings([a, b], ctx);
  const y = clusterFindings([b, a], ctx);
  assert.equal(x.length, 1);
  assert.equal(x[0].id, y[0].id);
  assert.match(x[0].id, /^[0-9a-f]{6}$/);
});

test('zwei Cluster am selben Anker stehen in einer von der Eingabe unabhaengigen Reihenfolge', () => {
  // Seit die Achse das Zitat ist, ist das der NORMALFALL: zwei Analysten zitieren
  // verschiedene Fragmente derselben Zeile und bekommen zwei Kommentare am selben
  // Anker. Severity, Analystenzahl, Datei, Zeile und Seite sind dann alle gleich --
  // ohne inhaltlichen Tiebreak entscheidet die Eingabereihenfolge, in welcher Reihenfolge
  // die beiden Kommentare im PR stehen, und zwei Laeufe mit denselben Befunden ergaeben
  // verschiedene Reviews.
  const a = f({ analyst: 'gi', line: 10, evidence: '@Disabled("flaky")', problem: 'p1', fix: 'f1' });
  const b = f({ analyst: 'sf', line: 10, evidence: 'assertTrue(true);', problem: 'p2', fix: 'f2' });
  const x = clusterFindings([a, b], ctx).map((c) => c.id);
  const y = clusterFindings([b, a], ctx).map((c) => c.id);
  assert.equal(x.length, 2);
  assert.deepEqual(x, y);
});

test('overlapStats zaehlt Analystenpaare, nicht nur Cluster', () => {
  // Die Zahl, gegen die man das Roster refinet. Ein Paar, das haeufig gemeinsam
  // auftaucht, zeigt eher eine unscharfe Reviergrenze als echte Mehrfachbetroffenheit --
  // aber nur, wenn man sieht, WELCHES Paar es ist. Die blosse Zahl der Mehrfach-Cluster
  // sagt darueber nichts.
  const stats = overlapStats([
    { analysts: ['gi', 'sf'], escalated: true },
    { analysts: ['gi', 'sf'], escalated: true },
    { analysts: ['gi'], escalated: false },
    { analysts: ['sf', 'cx'], escalated: false },
  ]);
  assert.equal(stats.clusters, 3);
  assert.equal(stats.escalated, 2);
  assert.deepEqual(stats.pairs, [
    { pair: 'gi + sf', count: 2 },
    { pair: 'cx + sf', count: 1 },
  ]);
});

test('overlapStats zerlegt einen Dreier in alle Paare', () => {
  // Bei drei Analysten an einem Ort ist die interessante Information, welche DREI
  // Grenzen dort aneinanderstossen -- nicht, dass es drei waren.
  const stats = overlapStats([{ analysts: ['cx', 'gi', 'sf'], escalated: true }]);
  assert.equal(stats.clusters, 1);
  assert.deepEqual(stats.pairs.map((p) => p.pair), ['cx + gi', 'cx + sf', 'gi + sf']);
});

test('overlapStats ist ohne Ueberlappung leer', () => {
  const stats = overlapStats([{ analysts: ['gi'], escalated: false }]);
  assert.equal(stats.clusters, 0);
  assert.deepEqual(stats.pairs, []);
});

test('LEFT und RIGHT mit identischer Evidenz ergeben verschiedene Cluster-IDs', () => {
  // Beim Verschieben von Code steht dasselbe Fragment einmal als entfernte und einmal
  // als hinzugefuegte Zeile im Diff. Die Cluster sind nach Seite getrennt -- wenn ihre
  // IDs es nicht sind, verwechselt der Zweitlauf die zugehoerigen Threads.
  const rechts = clusterFindings([f({ side: 'RIGHT' })], ctx)[0];
  const links = clusterFindings([f({ side: 'LEFT' })], ctx)[0];
  assert.equal(rechts.items[0].evidence, links.items[0].evidence);
  assert.equal(rechts.file, links.file);
  assert.notEqual(rechts.id, links.id);
});

test('Rueckgabe ist nach Severity sortiert', () => {
  const out = clusterFindings([
    f({ analyst: 'cx', file: 'src/B.java', line: 1, severity: 'minor', evidence: 'only one line' }),
    f({ analyst: 'gi', line: 10, severity: 'major', problem: 'p1', fix: 'f1' }),
    f({ analyst: 'sf', line: 12, severity: 'major', problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out[0].severity, 'blocker'); // eskaliert aus dem Doppelbefund
  assert.equal(out[1].severity, 'minor');
});

test('start_line deckt den ganzen Cluster ab', () => {
  // Zwei Analysten verankern dasselbe Zitat mit verschiedenen Bereichen. Der Kommentar
  // muss beide abdecken, sonst zeigt er auf einen Teil des Befundes.
  const out = clusterFindings([
    f({ analyst: 'gi', start_line: 10, line: 12, problem: 'p1', fix: 'f1' }),
    f({ analyst: 'sf', start_line: 15, line: 20, problem: 'p2', fix: 'f2' }),
  ], ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].start_line, 10);
  assert.equal(out[0].line, 20);
});
