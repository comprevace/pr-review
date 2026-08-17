import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAnalysts, selectAnalysts, parseFrontmatter } from '../lib/registry.mjs';

const ROOT = join(import.meta.dirname, '..');

test('die generischen Analysten laden fehlerfrei', () => {
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  const names = list.map((a) => a.name).sort();
  assert.deepEqual(names, ['consistency', 'gate-integrity', 'java-spring', 'rationale', 'security-context', 'spec-fidelity', 'test-substance', 'vue-ts', 'workflow-ci']);
});

test('alle laufen immer und haben sinnvolle Severity-Deckel', () => {
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  assert.equal(byName.get('gate-integrity').when, 'always');
  assert.equal(byName.get('gate-integrity').severity_max, 'blocker');
  assert.equal(byName.get('spec-fidelity').when, 'always');
  assert.equal(byName.get('spec-fidelity').severity_max, 'major');
  // major und nicht blocker: ein schwacher Test ist ein Mangel mit Folgen, aber er
  // haehlt nichts aus -- den Deckel blocker traegt nur, wer eine Pruefschicht
  // ausgehebelt findet.
  assert.equal(byName.get('test-substance').when, 'always');
  assert.equal(byName.get('test-substance').severity_max, 'major');
  // blocker, weil eine fehlende Autorisierungspruefung im Merge-Fall kein Mangel ist,
  // sondern ein Vorfall. Dieser Analyst ersetzt die frueher vorgesehene separate
  // Security-Action und muss deren Gewicht tragen koennen.
  assert.equal(byName.get('security-context').when, 'always');
  assert.equal(byName.get('security-context').severity_max, 'blocker');
  // major, nicht blocker: ein Musterbruch macht die Codebasis unlernbar, haehlt aber
  // nichts aus. Wer ihn zum blocker erklaert, entwertet die Stufe fuer die Faelle, in
  // denen wirklich etwas offen steht.
  assert.equal(byName.get('consistency').when, 'always');
  assert.equal(byName.get('consistency').severity_max, 'major');
  // Der einzige mit Deckel minor. Ein fehlendes Warum haelt niemanden auf -- es kostet
  // erst den naechsten Leser, und zwar dann richtig.
  assert.equal(byName.get('rationale').when, 'always');
  assert.equal(byName.get('rationale').severity_max, 'minor');
});

test('die sechs Kern-Analysten laufen auch bei einem Diff ohne passende Endung', () => {
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  const { selected, skipped } = selectAnalysts(list, ['README.md']);
  assert.equal(selected.length, 6);
  // java-spring ist der erste bedingte Analyst im Roster. Dass er hier NICHT laeuft und
  // stattdessen namentlich mit Grund in der Ausfallliste steht, ist der ganze Sinn von
  // when: paths -- und die Zeile, die spaeter in der Bilanz erklaert, warum das Review
  // schmaler ist, als das Roster vermuten laesst.
  assert.deepEqual(skipped.map((s) => s.name), ['java-spring', 'vue-ts', 'workflow-ci']);
  assert.equal(skipped[0].reason, 'kein Pfad im Diff passt auf **/*.java');
});

test('java-spring laeuft, sobald eine Java-Datei im Diff steht', () => {
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  const { selected, skipped } = selectAnalysts(list, ['src/main/java/app/Foo.java']);
  assert.equal(selected.length, 7);
  assert.deepEqual(skipped.map((s) => s.name), ['vue-ts', 'workflow-ci']);
});

test('workflow-ci laeuft bei Workflows UND bei Composite Actions', () => {
  // Der Glob ist bewusst breiter als .github/workflows/**: eine Composite Action ist
  // ausfuehrbarer CI-Code mit denselben Rechten und denselben Fallen.
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  for (const pfad of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'action.yml']) {
    const { selected } = selectAnalysts(list, [pfad]);
    assert.ok(selected.some((a) => a.name === 'workflow-ci'), `workflow-ci fehlt bei ${pfad}`);
  }
});

test('workflow-ci haengt am Pfad und darf blocker rufen', () => {
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const a = byName.get('workflow-ci');
  assert.equal(a.when, 'paths');
  // blocker, weil pull_request_target mit Checkout des PR-Heads direkt ausnutzbar ist
  // und mit Schreibrecht am Repo endet.
  assert.equal(a.severity_max, 'blocker');
  assert.ok(a.paths.includes('.github/workflows/**'));
  assert.ok(a.paths.some((p) => p.includes('action.y')), 'Composite Actions muessen abgedeckt sein');
});

test('workflow-ci meldet keine Injection — die prueft actionlint deterministisch', () => {
  // Der wichtigste Prinzip-2-Schnitt dieses Analysten, und einer, der der Spec
  // widerspricht: sie listet "Injection ueber ${{ }}" als seine Aufgabe. actionlint hat
  // dafuer eine eigene Regel und laeuft bereits in der Pipeline. Ein Analyst, der es
  // trotzdem meldet, erzeugt bei jedem Workflow-PR denselben Doppelbefund.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('workflow-ci').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /actionlint/i);
  assert.match(abgrenzung, /Injection|injection/);
  assert.match(abgrenzung, /gate-integrity/);
});

test('workflow-ci vermerkt, dass SHA-Pinning spaeter in ein Werkzeug gehoert', () => {
  // Bewusste Ausnahme: Pinning ist deterministisch pruefbar, aber derzeit prueft es
  // KEIN Werkzeug im Stack -- damit ist es nach Prinzip 2 heute zulaessig. Der Hinweis
  // haelt fest, dass es zu entfernen ist, sobald ein Lint-Schritt es uebernimmt. Ohne
  // ihn bleibt es fuer immer drin, weil niemand mehr weiss, warum es drin war.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  assert.match(byName.get('workflow-ci').body, /deterministisch|Lint-Schritt|Werkzeug/i);
});

test('vue-ts laeuft bei .vue UND bei .ts', () => {
  // Zwei getrennte Globs statt **/*.{vue,ts}: die Skip-Meldung nennt dann beide
  // Endungen einzeln, und die Auswahl haengt an keiner Brace-Unterstuetzung.
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  for (const pfad of ['src/components/Foo.vue', 'src/api/client.ts']) {
    const { selected } = selectAnalysts(list, [pfad]);
    assert.ok(selected.some((a) => a.name === 'vue-ts'), `vue-ts fehlt bei ${pfad}`);
  }
});

test('vue-ts haengt am Pfad und deckelt bei major', () => {
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const a = byName.get('vue-ts');
  assert.equal(a.when, 'paths');
  assert.deepEqual(a.paths, ['**/*.vue', '**/*.ts']);
  assert.equal(a.severity_max, 'major');
});

test('vue-ts prueft die Vue-Version, bevor es ein Mittel empfiehlt', () => {
  // Haerter als bei Spring: mehrere Empfehlungen haengen an der Minor-Version.
  // defineModel gibt es erst ab 3.4; ob das Destrukturieren von props die Reaktivitaet
  // verliert, haengt ebenfalls an der Version. Ein Analyst, der das nicht nachsieht,
  // empfiehlt etwas, das im Projekt nicht existiert -- oder meldet einen Befund, den
  // die eingesetzte Version gar nicht mehr hat.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('vue-ts').body;
  assert.match(body, /manifests\//, 'muss package.json als Quelle benennen');
  assert.match(body, /Version/, 'muss die Versionsabhaengigkeit benennen');
  assert.match(body, /niedrig/, 'muss den Weg ueber gesenktes Vertrauen benennen');
});

test('vue-ts ueberlaesst dem Linter, was der Linter kann', () => {
  // Bei Vue ist die Prinzip-2-Spannung groesser als bei Spring: eslint-plugin-vue deckt
  // in den empfohlenen Regelsaetzen einen erheblichen Teil der Konventionen ab. Ein
  // Analyst, der dieselben Regeln nachmeldet, erzeugt Doppelbefunde zu einem Werkzeug,
  // das es deterministisch und vollstaendiger kann.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('vue-ts').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /eslint-plugin-vue|ESLint/i);
  assert.match(abgrenzung, /consistency/);
});

test('java-spring haengt am Pfad und deckelt bei major', () => {
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const a = byName.get('java-spring');
  assert.equal(a.when, 'paths');
  assert.deepEqual(a.paths, ['**/*.java']);
  assert.equal(a.severity_max, 'major');
});

test('java-spring sagt, was er ohne Manifest nicht wissen kann', () => {
  // Der Analyst empfiehlt Framework-Mittel. Ob das jeweilige Mittel ueberhaupt auf dem
  // Classpath liegt, steht im Manifest -- und in einem mehrmodulmodularen Projekt kann
  // genau das Modul-Manifest fehlen, weil nur die Wurzel geholt wird. Ein Analyst, der
  // das nicht sagt, empfiehlt @Cacheable in ein Projekt ohne Cache-Starter.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('java-spring').body;
  assert.match(body, /manifests\//, 'muss die Manifestdatei als Quelle benennen');
  assert.match(body, /Classpath|classpath/, 'muss den Classpath-Vorbehalt benennen');
  assert.match(body, /niedrig/, 'muss den Weg ueber gesenktes Vertrauen benennen');
});

test('java-spring grenzt sich gegen consistency und die deterministischen Werkzeuge ab', () => {
  // consistency besitzt "eigene Hilfsfunktion neben einer vorhandenen" -- aber
  // repo-lokal. Hier liegt das Vorhandene im FRAMEWORK, nicht im Repo. Ohne die
  // ausdrueckliche Grenze meldet jeder von beiden dieselbe Zeile.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('java-spring').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /consistency/);
  assert.match(abgrenzung, /Error Prone|Spotless|Linter|Compiler/i);
});

test('rationale lehrt keine Severity-Luege, um niedriges Vertrauen durchzubekommen', () => {
  // Der einzige Analyst, bei dem die Vertrauensregel wirklich beisst. Nachgemessen an der
  // Maschinerie: minor + niedrig wird verworfen, major + niedrig kommt DURCH und wird auf
  // minor gedeckelt. Damit existiert ein Schleichweg -- Severity aufblasen, um einen
  // unsicheren Befund unterzubringen -- und ein Prompt, der ihn empfiehlt, wuerde die
  // Severity-Leiter fuer alle entwerten. Der Prompt muss den Weg benennen UND verbieten.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('rationale').body;
  assert.match(body, /niedrig/, 'muss die Vertrauensregel ansprechen');
  assert.match(body, /schweig|weglassen|nicht melden/i, 'muss Schweigen als Ausweg nennen');
  assert.match(body, /Severity-Lüge|Severity-Luege|nicht.*aufblasen|nicht.*höher melden/i,
    'muss das Aufblaeen der Severity ausdruecklich verbieten');
});

test('rationale grenzt sich gegen consistency und gate-integrity ab', () => {
  // consistency fragt, ob etwas ANDERS ist; rationale, ob es ERKLAERT ist -- dieselbe
  // Zeile kann beides sein. Und ein neues @SuppressWarnings ohne Begruendung gehoert
  // bereits gate-integrity, der es genau danach unterscheidet.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('rationale').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /consistency/);
  assert.match(abgrenzung, /gate-integrity/);
});

test('consistency sagt, dass aus siblings/ nicht zitiert werden darf', () => {
  // Er ist der einzige Analyst, fuer den die Nachbarschaft ueberhaupt geholt wird -- und
  // damit der einzige, der ernsthaft in Versuchung kommt, sie zu zitieren. Genau das
  // verwirft die Maschinerie, weil ein Geschwister keine geaenderte Datei ist. Ohne den
  // Hinweis im eigenen Prompt produziert er systematisch Ausschuss.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('consistency').body;
  assert.match(body, /siblings\//, 'muss das Verzeichnis benennen');
  assert.match(body, /nicht zitier|verworfen/i, 'muss sagen, dass von dort kein Zitat stammen darf');
  assert.match(body, /geänderte|geaenderte/i, 'muss auf die geaenderte Datei als Anker verweisen');
});

test('security-context haelt sich von dem fern, was ein Scanner deterministisch prueft', () => {
  // Prinzip 2 des Konzepts: ein LLM-Analyst ist nur berechtigt, wo kein Werkzeug die
  // Sache besser prueft. Kein Analyst ist so versucht wie dieser -- Secrets im Klartext
  // und bekannte CVEs sind das Erste, wonach ein Sicherheitsprompt sucht, und beides ist
  // bereits deterministisch abgedeckt. Ohne die ausdrueckliche Ausgrenzung liefert er
  // Doppelbefunde zu Gitleaks und osv-scanner, und der Leser gewoehnt sich daran, ihn zu
  // ueberblaettern.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('security-context').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /Gitleaks|Secret/i, 'muss Secrets im Klartext ausgrenzen');
  assert.match(abgrenzung, /osv-scanner|CVE/i, 'muss bekannte CVEs ausgrenzen');
  assert.match(abgrenzung, /gate-integrity/, 'muss die Stilllegung von Pruefungen abgrenzen');
});

test('security-context meldet keine ${{ }}-Injection — die prueft actionlint', () => {
  // Gemessen am 13.08.: workflow-ci verschwieg die Injection korrekt, security-context
  // meldete sie (release.yml:15, blocker). Derselbe Prinzip-2-Schnitt wie bei workflow-ci,
  // nur am anderen Analysten -- und er war nur bei EINEM von beiden gezogen. Eine
  // Abgrenzung, die paarweise geschrieben wird, laesst genau solche Luecken: der Ort
  // gehoert einem deterministischen Werkzeug, also muss ihn JEDER Analyst meiden, der ihn
  // sehen kann, nicht nur der naechstliegende.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('security-context').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /actionlint/i, 'muss actionlint als Eigentuemer benennen');
  assert.match(abgrenzung, /Injection|injection/, 'muss die Injection ausdruecklich ausgrenzen');
  assert.match(abgrenzung, /workflow-ci/, 'muss den Nachbarn benennen, der Workflows prueft');
});

test('security-context gibt pull_request_target nicht an workflow-ci ab', () => {
  // Regression aus der actionlint-Abgrenzung, gefunden im Messlauf vom 13.08.: der Satz
  // "was am Ausloeser und an den Rechten haengt, gehoert workflow-ci" nahm security-context
  // nicht nur die ${{ }}-Interpolation (richtig), sondern auch pull_request_target mit
  // Checkout des Fork-Standes (falsch). Bundle B sichert diesen Fall seit der Sonden-
  // Erweiterung BEIDEN Analysten zu -- im Messlauf davor hatten beide ihn gemeldet. Die
  // Abgrenzung widersprach also der eigenen Landkarte: ein Fix gegen einen Befund zerstoerte
  // die Eigenschaft, die zwei Commits vorher als gepflanzte Ueberlappung zugesichert war.
  //
  // Der Schnitt muss schmal sein: ausgegrenzt ist die Interpolation, nicht der Ausloeser.
  // Kein Satz der Abgrenzung darf pull_request_target einem anderen zuschlagen, und
  // mindestens einer muss es ausdruecklich als eigenen Befund behaupten.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('security-context').body.split('NICHT deine Sache')[1] ?? '';
  const saetze = abgrenzung.split(/(?<=\.)\s+/);
  const mitTrigger = saetze.filter((s) => /pull_request_target/.test(s));
  assert.ok(mitTrigger.length > 0,
    'die Abgrenzung muss pull_request_target ausdruecklich behandeln -- Schweigen liesse die Grenze offen');
  for (const satz of mitTrigger) {
    assert.doesNotMatch(satz, /geh[öo]rt\s+`?workflow-ci/,
      'pull_request_target darf nicht workflow-ci zugeschlagen werden -- Bundle B sichert den Fall beiden zu');
  }
  assert.ok(mitTrigger.some((s) => /dein Befund|meldest du/.test(s)),
    'die Abgrenzung muss pull_request_target als eigenen Befund behaupten');
});

test('gate-integrity erfindet keinen Anker fuer eine fehlende Testdatei', () => {
  // Gemessen am 13.08.: gate-integrity verankerte "UI-Komponente ohne jede Testdatei" auf
  // der watch-Zeile -- derselben, die vue-ts fuer seinen Reaktivitaetsbefund zitiert.
  // Seit Cluster nach dem Zitat gebildet werden, ist das ein gemeinsamer Cluster aus zwei
  // voellig verschiedenen Sachen, und die Severity-Erhoehung feuert darauf.
  //
  // Die Ursache ist strukturell und nicht durch eine bessere Zeilenwahl zu heilen: die
  // Information steht in meta.json -> missing_tests, und meta.json ist NICHT zitierbar.
  // Der Analyst muss sich also irgendeine Zeile aus der Datei leihen -- und jede geliehene
  // Zeile gehoert dem, der sie fachlich prueft. Ein Befund ueber eine ABWESENHEIT hat
  // keinen eigenen Anker.
  //
  // Abschnitt 8.6 des Designs beantwortet das bereits: ankerlose Befunde gehen in die
  // Bilanz. Und dort steht die fehlende Testdatei ohnehin schon -- der Bundle-Bau vermerkt
  // sie deterministisch unter "Luecken in der Eingabe". Der Prompt hat die Regel umgangen,
  // indem er sich einen Anker beschaffte.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const [blickrichtung, abgrenzung = ''] = byName.get('gate-integrity').body.split('NICHT deine Sache');
  assert.doesNotMatch(
    blickrichtung, /missing_tests/,
    'die Blickrichtung darf nicht mehr zu einem Inline-Befund aus missing_tests anleiten',
  );
  assert.match(abgrenzung, /missing_tests/, 'die Abgrenzung muss missing_tests benennen');
  assert.match(abgrenzung, /Bilanz/, 'muss sagen, wo der Befund stattdessen steht');
  assert.match(abgrenzung, /Abwesenheit|abwesend|fehlt.*Anker|keinen eigenen Anker/i,
    'muss die Regel fuer Befunde ohne eigenen Anker benennen');
});

test('gate-integrity leiht sich fuer den Workflow-ohne-Bezug-Befund keinen Anker', () => {
  // Zweite Stelle desselben Lecks, gefunden im Messlauf vom 13.08.: gate-integrity meldete
  // "Neuer CI-Workflow ohne Bezug zum PR-Inhalt" und zitierte dafuer permissions: write-all
  // -- die Zeile, die workflow-ci fachlich prueft. Gemeinsames Cluster, beide major,
  // Erhoehung auf blocker. Die Abwesenheitsregel aus Befund 4 griff nicht, weil "ohne Bezug
  // zum PR" nicht wie eine Abwesenheit klingt -- es ist aber eine: der fehlende Bezug hat
  // keine eigene Zeile.
  //
  // Anders als bei missing_tests bleibt der Fall ein Inline-Befund, denn er traegt eine
  // sichtbare Aenderung: den neuen Workflow selbst. Der Prompt muss deshalb den Anker
  // vorschreiben, der die Aenderung zeigt (die name:-Zeile), und die geliehenen Zeilen
  // ausdruecklich verbieten.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const [blick, abgrenzung = ''] = byName.get('gate-integrity').body.split('NICHT deine Sache');
  assert.match(blick, /nichts mit CI zu tun/, 'das Suchmuster selbst muss bleiben -- der Fall ist echt');
  assert.match(blick, /`name:`/, 'muss den Anker vorschreiben, der die Aenderung selbst zeigt');
  assert.match(blick, /permissions|Ausl[öo]ser/i, 'muss die Zeilen benennen, die Nachbarn gehoeren');
  assert.match(blick, /leih|geliehen/i, 'muss das Leihen beim Namen nennen');
  assert.match(abgrenzung, /ohne Bezug|klingt nicht/i,
    'die Abwesenheitsregel muss die getarnte Abwesenheit abdecken, sonst greift sie wieder nicht');
});

test('spec-fidelity meldet eine fehlende Spec nicht mehr als Befund', () => {
  // Gemessen am 14.08. auf fuenf echten PRs (Betreiber-Messung 14.08.): die leere
  // spec.md erzeugte fuenfmal denselben verankerten major mit dekorativem Zitat aus der
  // ersten geaenderten Zeile -- die einzige major-Quelle der ganzen Runde. Dabei ist das
  // Fehlen deterministisch bekannt (meta.spec_missing) und steht seit jeher in der
  // Bilanz unter "Luecken in der Eingabe": der Analysten-Befund war eine Doppelmeldung
  // UND ein Verstoss gegen die eigene Abwesenheitsregel (REVIERMATRIX E) -- eine
  // Abwesenheit hat keinen eigenen Anker, und die erste geaenderte Zeile belegt nichts.
  //
  // Schweigen zur fehlenden Spec heisst nicht verstummen: die Konventionspruefung (K1)
  // traegt ihn auch ohne Bezugsdokument. Nur Kriteriums-Befunde haben ohne Spec keine
  // Grundlage.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('spec-fidelity').body;
  assert.doesNotMatch(body, /Melde genau \*\*einen\*\* Befund/,
    'die Anweisung zum verankerten Spec-fehlt-Befund muss weg');
  assert.doesNotMatch(body, /ersten geänderten Zeile/,
    'der geliehene Anker an der ersten geaenderten Zeile muss weg');
  assert.match(body, /Bilanz/, 'muss die Bilanz als Ort des Fehlens nennen');
  assert.match(body, /spec_missing/, 'muss das deterministische Feld benennen');
  const leerAbschnitt = /Wenn `spec\.md` leer ist[\s\S]*?(?=\n##|$)/.exec(body)?.[0] ?? '';
  assert.match(leerAbschnitt, /conventions\.md/,
    'muss sagen, dass die Konventionspruefung ohne Spec weiterlaeuft');
});

test('security-context verlangt Zurueckhaltung, wo die Kontextgrenze urteilt', () => {
  // Der gefaehrlichste Analyst fuer Falschbefunde: Autorisierung wird haeufig zentral
  // erzwungen -- in einem Interceptor, einer Filterkette, einer Policy-Datei -- und
  // nichts davon liegt im Bundle. Ein Prompt, der aus "hier steht kein @PreAuthorize"
  // auf "hier fehlt die Pruefung" schliesst, produziert genau die Alarm-Muedigkeit, die
  // das Konzept vermeiden will. Er muss also sagen duerfen, was er nicht sehen konnte.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('security-context').body;
  assert.match(body, /niedrig/, 'muss den Weg ueber confidence: niedrig benennen');
  assert.match(body, /zentral|Interceptor|Filterkette|an anderer Stelle/i,
    'muss den Fall der anderswo erzwungenen Kontrolle behandeln');
});

test('test-substance warnt vor dem Zitat aus einer unveraenderten Testdatei', () => {
  // Dieser Analyst bekommt tests/ zwangslaeufig in die Hand -- es ist sein Gegenstand.
  // Genau von dort ist ein Zitat aber maschinell nicht auffindbar und wird verworfen.
  // Ohne den Hinweis im eigenen Prompt produziert ausgerechnet er den Ausschuss, den
  // der Kontrakt-Test unten beschreibt: woertlich richtig zitiert, trotzdem weg. Das
  // ist dieselbe Fehlerklasse wie der Kontrakt, der zu confidence: niedrig riet und
  // damit Befunde erzeugte, die der Validator verwirft.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const body = byName.get('test-substance').body;
  assert.match(body, /unverändert/i, 'muss den Fall der unveraenderten Testdatei behandeln');
  assert.match(body, /nicht zitierbar|nicht zitier|verworfen/i, 'muss sagen, dass von dort kein Zitat stammen darf');
});

test('test-substance grenzt sich gegen seine zwei Nachbarn ab', () => {
  // Die beiden, mit denen er sich am leichtesten ueberschneidet, benennen ihn bereits
  // als Eigentuemer der Testqualitaet. Nennt er sie nicht zurueck, meldet er das, was
  // ihnen gehoert, mit -- und die Mehrfachbefund-Erhoehung zeigt dann nicht mehr echte
  // Mehrfachbetroffenheit an, sondern nur noch unscharfe Reviergrenzen.
  const byName = new Map(loadAnalysts([join(ROOT, 'analysts')]).map((a) => [a.name, a]));
  const abgrenzung = byName.get('test-substance').body.split('NICHT deine Sache')[1] ?? '';
  assert.match(abgrenzung, /gate-integrity/);
  assert.match(abgrenzung, /spec-fidelity/);
});

test('wer die fehlende Testdatei abgrenzt, sagt auch, wo sie stattdessen steht', () => {
  // Aufgedeckt von einer Mutationsprobe: die Gleichung "Sonde == Prompts" prueft nur, DASS
  // ein Prompt missing_tests erwaehnt, nicht WAS er dazu sagt. Damit blieb der Rueckweg
  // offen -- test-substance verwies fuer diesen Fall auf gate-integrity als Eigentuemer,
  // und nachdem gate-integrity ihn abgegeben hatte, zeigte der Verweis auf niemanden.
  //
  // Ein Analyst, der glaubt, ein anderer kuemmere sich, schweigt. Stimmt der Verweis nicht
  // mehr, greift er selbst zu -- und leiht sich wieder einen Anker. Der Fall hat seit
  // Befund 4 keinen Eigentuemer im Roster, sondern einen Ort: die Bilanz. Wer ihn abgrenzt,
  // muss diesen Ort nennen, nicht einen Kollegen.
  for (const analyst of loadAnalysts([join(ROOT, 'analysts')])) {
    const abgrenzung = analyst.body.split('NICHT deine Sache')[1] ?? '';
    if (!/missing_tests/.test(abgrenzung)) continue;
    assert.match(abgrenzung, /Bilanz/,
      `${analyst.name} grenzt missing_tests ab, ohne die Bilanz als Ort zu nennen`);
  }
});

test('jeder Analyst hat den Pflichtabschnitt zur Abgrenzung', () => {
  for (const analyst of loadAnalysts([join(ROOT, 'analysts')])) {
    assert.match(analyst.body, /NICHT deine Sache/, `${analyst.name} fehlt der Abgrenzungsabschnitt`);
  }
});

test('der Kontrakt legt Schema, Evidenzpflicht und Severity fest', () => {
  const contract = readFileSync(join(ROOT, 'analyst-contract.md'), 'utf8');
  for (const needle of ['evidence', 'fix', 'severity', 'confidence', 'einzeilig', '200', 'findings/']) {
    assert.match(contract, new RegExp(needle), `Kontrakt erwaehnt "${needle}" nicht`);
  }
});

test('der Kontrakt verspricht keine Evidenz, die der Validator verwirft', () => {
  // Der Kontrakt fuehrte tests/, spec.md und conventions.md als Bundle-Inhalt auf, ohne
  // zu sagen, dass die Evidenz nur aus einer GEAENDERTEN Datei stammen darf. gate-integrity
  // soll entfernte Assertions jagen und bekommt tests/ in die Hand: ein woertlich richtiges
  // Zitat aus einer unveraenderten Testdatei wurde als "Evidenz im Bundle nicht auffindbar"
  // verworfen -- der Kontrakt selbst produzierte den Ausschuss.
  const contract = readFileSync(join(ROOT, 'analyst-contract.md'), 'utf8');
  assert.match(contract, /geänderten Dateien aus `meta\.json`/);
  assert.match(contract, /files\/<file>/);
  assert.match(contract, /patches\/<file>\.patch/);
  // \s+ statt Leerzeichen: der Satz zaehlt inzwischen fuenf Quellen auf und bricht um.
  // Ein Test, der am Zeilenumbruch scheitert, prueft die Formatierung statt der Aussage.
  assert.match(contract, /sind nicht\s+zitierbar\.\*\*/);
  // siblings/ ist die juengste und gefaehrlichste Ergaenzung: es enthaelt UNVERAENDERTE
  // Dateien. Fehlte es in dieser Aufzaehlung, waere der Kontrakt an der Stelle falsch,
  // an der er am meisten gilt.
  assert.match(contract, /`siblings\/`/);
  assert.match(contract, /`manifests\/`/);
  assert.match(contract, /Verstehen/);
});

test('der Agent-Typ hat kein Bash und kein Netz, aber Write', () => {
  const { meta } = parseFrontmatterLoose(readFileSync(join(ROOT, 'agents/pr-review-analyst.md'), 'utf8'));
  const tools = String(meta.tools);
  assert.match(tools, /Read/);
  assert.match(tools, /Grep/);
  // Write ist Pflicht, nicht Kosmetik: der Kontrakt verlangt vom Analysten, seine
  // Befunde nach <bundle>/findings/<name>.json zu SCHREIBEN. Ohne Write kann er seine
  // Arbeit physisch nicht abliefern, und jeder Lauf endet mit "alle Analysten
  // ausgefallen" -- was genau einmal passiert ist, weil dieser Test urspruenglich nur
  // geprueft hat, was FEHLEN muss, und nie, was DA SEIN muss.
  assert.match(tools, /Write/);
  assert.doesNotMatch(tools, /Bash/);
  assert.doesNotMatch(tools, /WebFetch/);
  assert.doesNotMatch(tools, /WebSearch/);
});

// Der Agent-Typ nutzt andere Frontmatter-Schluessel als ein Analyst; die strenge
// Registry-Pruefung passt hier nicht.
function parseFrontmatterLoose(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta };
}
