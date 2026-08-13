import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceIndex, findingId, evidenceHash, renderMarker, parseMarker, renderComment, parseEvidence } from '../lib/comment.mjs';

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
  const a = findingId('src/A.java', '@Disabled("flaky")', 1, 'RIGHT');
  const b = findingId('src/A.java', '  @Disabled("flaky")  ', 1, 'RIGHT');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{6}$/);
});

test('findingId unterscheidet Vorkommen und Dateien', () => {
  assert.notEqual(findingId('src/A.java', 'x', 1, 'RIGHT'), findingId('src/A.java', 'x', 2, 'RIGHT'));
  assert.notEqual(findingId('src/A.java', 'x', 1, 'RIGHT'), findingId('src/B.java', 'x', 1, 'RIGHT'));
});

test('findingId unterscheidet LEFT und RIGHT', () => {
  // Eine entfernte und eine hinzugefuegte Zeile koennen woertlich dasselbe Fragment
  // enthalten -- beim Verschieben von Code ist das der Normalfall, nicht der Randfall.
  // Ohne die Seite im Schluessel teilen sich die beiden Cluster eine ID. Der Zweitlauf
  // beantwortet Bedingung (1) dann fuer den einen Thread mit der Meldung des anderen:
  // wird die RIGHT-Seite behoben und die LEFT-Seite weiter gemeldet, bleibt der falsche
  // Thread offen. Zusaetzlich ueberschreibt clusterById den einen Cluster mit dem
  // anderen, womit ein Rueckfall auf den falschen Befund gepostet wird.
  assert.notEqual(
    findingId('src/A.java', 'x', 1, 'LEFT'),
    findingId('src/A.java', 'x', 1, 'RIGHT'),
  );
});

test('findingId trennt Datei und Evidenz eindeutig', () => {
  // Mit einem Leerzeichen als Trenner ergaeben ("src/my file", "x") und ("src/my",
  // "file x") denselben Hash-Input -- zwei verschiedene Befunde teilten sich eine ID.
  // Ein Dateipfad darf ein Leerzeichen enthalten, das NUL-Byte nicht.
  assert.notEqual(
    findingId('src/my file', 'x', 1, 'RIGHT'),
    findingId('src/my', 'file x', 1, 'RIGHT'),
  );
});

test('findingId verlangt eine Seite und nimmt keinen stillen Standardwert an', () => {
  // Ein Standardwert 'RIGHT' waere die gefaehrlichere Variante: ein Aufrufer, der die
  // Seite vergisst, erzeugte genau die kollidierenden IDs zurueck, die dieser Schluessel
  // beseitigt -- und nichts wuerde es anzeigen. Lieber laut scheitern.
  assert.throws(() => findingId('src/A.java', 'x', 1), /side/i);
  assert.throws(() => findingId('src/A.java', 'x', 1, 'BOTH'), /side/i);
});

test('renderMarker und parseMarker sind zueinander invers', () => {
  const marker = renderMarker({ id: 'a3f9c1', sev: 'blocker', ev: 'deadbeef', analysts: ['gate-integrity', 'spec-fidelity'] });
  assert.match(marker, /^<!-- pr-review:v2 /);
  assert.deepEqual(parseMarker(`text\n${marker}\n`), {
    version: 'v2', id: 'a3f9c1', sev: 'blocker', ev: 'deadbeef', analysts: ['gate-integrity', 'spec-fidelity'],
  });
});

test('evidenceHash ist unabhaengig von Whitespace und im Marker lesbar', () => {
  assert.equal(evidenceHash('  x = 1;  '), evidenceHash('x = 1;'));
  assert.match(evidenceHash('x'), /^[0-9a-f]{8}$/);
  assert.equal(parseMarker(renderMarker({ id: 'aaaaaa', sev: 'major', ev: evidenceHash('x'), analysts: [] })).ev, evidenceHash('x'));
});

test('ein Marker ohne ev bleibt lesbar (Rueckwaertskompatibilitaet)', () => {
  const old = '<!-- pr-review:v1 id=aaaaaa sev=major analysts=gi -->';
  assert.deepEqual(parseMarker(old), { version: 'v1', id: 'aaaaaa', sev: 'major', ev: null, analysts: ['gi'] });
});

test('ein v1-Marker eines frueheren Laufs bleibt lesbar', () => {
  // Der Versionswechsel rotiert alle IDs. Wuerde v2 die alten Marker nicht mehr lesen,
  // faellt jeder bestehende Thread in die Klasse "fremder Kommentar" und wird nie wieder
  // angetastet -- er haengt fuer immer offen, auch wenn der Befund laengst behoben ist.
  // Gelesen bleibt er ueber sein Zitat aufloesbar; nur seine ID passt zu keinem Cluster
  // mehr, und das ist der bewusst bezahlte Preis der Rotation (ein Duplikat, kein
  // falsches "behoben").
  assert.deepEqual(parseMarker('<!-- pr-review:v1 id=aaaaaa sev=major ev=deadbeef analysts=gi -->'), {
    version: 'v1', id: 'aaaaaa', sev: 'major', ev: 'deadbeef', analysts: ['gi'],
  });
});

test('parseMarker ignoriert fremde Kommentare', () => {
  assert.equal(parseMarker('nur ein normaler Review-Kommentar'), null);
  assert.equal(parseMarker('<!-- andere-tooling id=1 -->'), null);
});

test('ein zitierter Marker mitten im Text gilt nicht als gesetzt', () => {
  // Sonst unterdrueckt eine menschliche Erklaerung des Verfahrens einen echten
  // Befund: der Zweitlauf haelt ihn fuer schon kommentiert.
  const marker = renderMarker({ id: 'aaaaaa', sev: 'major', ev: 'deadbeef', analysts: ['gi'] });
  const quoted = ['So sieht der Marker aus:', '', '```', marker, '```', '', 'Ende.'].join('\n');
  assert.equal(parseMarker(quoted), null);
});

test('analysts mit Komma am Ende ergibt keinen Leereintrag', () => {
  assert.deepEqual(parseMarker('<!-- pr-review:v1 id=aaaaaa sev=major analysts=gi, -->').analysts, ['gi']);
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

test('parseEvidence liest das Zitat aus einem gerenderten Kommentar', () => {
  const body = renderComment(cluster);
  assert.equal(parseEvidence(body), '@Disabled("flaky")');
  assert.equal(parseEvidence('nur Text ohne Zitat'), null);
});

test('renderComment weist niedriges Vertrauen aus', () => {
  const low = { ...cluster, items: [{ ...cluster.items[0], confidence: 'niedrig' }],
    analysts: ['gate-integrity'], tension: false, escalated: false };
  assert.match(renderComment(low), /Vertrauen: niedrig/);
});
