import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { commentableRanges } from '../../lib/diff.mjs';

// Synthetisch, ohne jeden Projektbezug. Fuenf gepflanzte Faelle:
//   A + B  zwei Analysten zitieren DASSELBE Fragment, verankern es aber verschieden
//          (Zeile 10 und 12) -> EIN Kommentar, zwei Tags, von major auf blocker erhoeht
//   E      ein dritter Befund zwei Zeilen daneben mit einem ANDEREN Zitat -> ein
//          ZWEITER Kommentar, nicht erhoeht
//   C      Befund auf Zeile 17, die ausserhalb der Diff-Hunks liegt -> Bilanz
//   D      Befund mit Evidenz, die im Bundle nicht vorkommt -> verworfen, gezaehlt
//
// A+B und E sind ein Paar und pruefen die Cluster-Achse in BEIDE Richtungen. Bis 0.10.0
// war der Schluessel die Zeilennaehe, und A+B lagen deshalb auf zwei verschiedenen
// Zitaten: Zeile 10 und 12 verschmolzen wegen der Toleranz von drei Zeilen. Genau das
// war der Defekt -- mit neun Analysten verschluckte diese Toleranz eine ganze
// Dateiregion. Seit der Schluessel das Zitat ist, beweist A+B die Verschmelzung nur
// noch, wenn beide Analysten dasselbe Fragment zitieren; E beweist die Gegenrichtung,
// die es vorher gar nicht gab. Ohne E wuerde eine Rueckkehr zur Zeilennaehe von dieser
// Fixture nicht bemerkt.
const A_LINES = [
  'package example;',                       // 1
  '',                                       // 2
  'import org.junit.jupiter.api.Disabled;',  // 3
  'import org.junit.jupiter.api.Test;',      // 4
  '',                                       // 5
  'class SessionTest {',                     // 6
  '',                                       // 7
  '  @Test',                                 // 8
  '  void rejectsExpiredSession() {',        // 9
  '    @Disabled("flaky")',                  // 10  <- Fall A
  '    var session = new Session();',        // 11
  '        assertTrue(true);',               // 12  <- Fall B
  '  }',                                    // 13
  '',                                       // 14
  '  @Test',                                 // 15
  '  void other() {',                        // 16
  '    // nothing',                          // 17
  '  }',                                    // 18
  '}',                                      // 19
  '',                                       // 20
];

const B_LINES = [
  'package example;',                       // 1
  '',                                       // 2
  'class Legacy {',                          // 3
  '  void run() {',                          // 4
  '    step();',                             // 5
  '  }',                                    // 6
  '',                                       // 7
  '  void step() {',                         // 8
  '  }',                                    // 9
  '',                                       // 10
  '  void unused() {',                       // 11
  '  }',                                    // 12
  '',                                       // 13
  '  void more() {',                         // 14
  '  }',                                    // 15
  '',                                       // 16
  '    // legacy fallback',                  // 17  <- Fall C, ausserhalb der Hunks
  '',                                       // 18
  '}',                                      // 19
  '',                                       // 20
];

// Hunk deckt RIGHT 8..14 ab (Fall A und B liegen drin).
const A_PATCH = [
  '@@ -8,5 +8,7 @@ class SessionTest {',
  '   @Test',
  '   void rejectsExpiredSession() {',
  '+    @Disabled("flaky")',
  '     var session = new Session();',
  '+        assertTrue(true);',
  '   }',
  ' ',
].join('\n');

// Hunk deckt RIGHT 3..5 ab. Zeile 17 liegt bewusst ausserhalb.
const B_PATCH = ['@@ -3,3 +3,3 @@', ' class Legacy {', '   void run() {', '-    old();', '+    step();'].join('\n');

function write(dir, rel, content) {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function makeBundleA(dir) {
  const aText = `${A_LINES.join('\n')}`;
  const bText = `${B_LINES.join('\n')}`;

  write(dir, 'files/src/A.java', aText);
  write(dir, 'files/src/B.java', bText);
  write(dir, 'patches/src/A.java.patch', A_PATCH);
  write(dir, 'patches/src/B.java.patch', B_PATCH);
  write(dir, 'diff.patch', `--- a/src/A.java\n+++ b/src/A.java\n${A_PATCH}\n--- a/src/B.java\n+++ b/src/B.java\n${B_PATCH}`);
  write(dir, 'spec.md', '# DEMO-1\n\n1. Eine abgelaufene Session wird abgewiesen.\n');
  write(dir, 'conventions.md', '# Konventionen\n\nKeine abgeschalteten Tests auf main.\n');
  write(dir, 'previous.json', '[]');

  write(dir, 'meta.json', JSON.stringify({
    repo: 'example/demo',
    number: 1,
    title: 'DEMO-1: Session-Ablauf',
    body: 'siehe specs/DEMO-1.md',
    author: 'agent',
    labels: [],
    base_sha: 'base',
    head_sha: 'head',
    head_ref: 'feature/DEMO-1-session',
    spec_link: 'specs/DEMO-1.md',
    spec_missing: false,
    conventions_missing: false,
    missing_tests: [],
    files: [
      { path: 'src/A.java', status: 'modified', additions: 2, deletions: 0, commentable: commentableRanges(A_PATCH) },
      { path: 'src/B.java', status: 'modified', additions: 1, deletions: 1, commentable: commentableRanges(B_PATCH) },
    ],
  }, null, 2));

  write(dir, 'findings/gate-integrity.json', JSON.stringify([
    {
      file: 'src/A.java', line: 10, side: 'RIGHT', severity: 'major',
      title: 'Test stillgelegt ohne Ersatz',
      problem: 'Der Test ist abgeschaltet, ohne dass eine andere Pruefung die Zeitgrenze absichert.',
      evidence: '@Disabled("flaky")',
      fix: 'Entferne @Disabled und injiziere einen Zeitgeber statt Instant.now().',
      confidence: 'high',
    },
    {
      file: 'src/B.java', line: 17, side: 'RIGHT', severity: 'major',
      title: 'Toter Zweig bleibt stehen',
      problem: 'Der Legacy-Pfad wird nicht mehr erreicht, bleibt aber im Code.',
      evidence: '// legacy fallback',
      fix: 'Entferne den toten Zweig.',
      confidence: 'high',
    },
  ], null, 2));

  write(dir, 'findings/spec-fidelity.json', JSON.stringify([
    {
      // Fall B: dasselbe Fragment wie gate-integrity, anders verankert. Das ist der
      // Normalfall echter Ueberlappung -- und es ist die Konstellation, die das
      // Kommentarbeispiel des Designs (Abschnitt 9.1) ohnehin schon zeigt: ein
      // Kommentar, getaggt mit Gate-Integritaet UND Spec-Treue, ueber @Disabled.
      file: 'src/A.java', line: 12, side: 'RIGHT', severity: 'major',
      title: 'Kriterium 1 nicht abgedeckt',
      problem: 'Der stillgelegte Test war die einzige Absicherung von Akzeptanzkriterium 1.',
      evidence: '@Disabled("flaky")',
      fix: 'Pruefe, dass eine Session aelter als 30 Minuten abgewiesen wird.',
      confidence: 'high',
    },
    {
      // Fall E: zwei Zeilen neben Fall A, aber ein anderes Zitat. Unter der alten
      // Toleranz von drei Zeilen waere dieser Befund im Kommentar von A+B verschwunden.
      file: 'src/A.java', line: 12, side: 'RIGHT', severity: 'major',
      title: 'Tautologische Assertion',
      problem: 'Die Assertion ist wahr, unabhaengig vom Verhalten des Codes.',
      evidence: 'assertTrue(true);',
      fix: 'Pruefe das Ergebnis von handle() statt einer Konstanten.',
      confidence: 'high',
    },
    {
      file: 'src/A.java', line: 10, side: 'RIGHT', severity: 'major',
      title: 'Erfundener Befund',
      problem: 'Existiert nicht und muss verworfen werden.',
      evidence: 'dieser-text-existiert-im-bundle-nicht',
      fix: 'Sollte nie gepostet werden.',
      confidence: 'high',
    },
  ], null, 2));

  return dir;
}
