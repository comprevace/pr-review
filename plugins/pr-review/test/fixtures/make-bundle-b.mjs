// Bundle B — das Roster-Bundle. Synthetisch, ohne jeden Projektbezug.
//
// Zweck ist ein anderer als bei Bundle A: A prueft die Maschinerie (Clustern, Kappen,
// Verwerfen), B ist das Werkzeug zum Tunen der PROMPTS. Es pflanzt fuer jeden der neun
// Analysten mindestens einen Fall, den er finden soll — und mehrere Sonden, die er
// ausdruecklich NICHT melden darf, weil sie einem Nachbarn oder einem deterministischen
// Werkzeug gehoeren.
//
// Benutzung:
//   node test/fixtures/make-bundle-b.mjs /pfad/zum/bundle
//   pr-review post --bundle /pfad/zum/bundle --dry-run
// dazwischen einen Analysten gegen das eingefrorene Bundle laufen lassen.
//
// PLANTED unten ist die Landkarte. Der Test `fixture-b.test.mjs` prueft daran zweierlei:
// dass jede gepflanzte Evidenz woertlich auffindbar und ihre Zeile kommentierbar ist.
// Ohne diese Pruefung waere das Bundle eine Falle: ein Analyst faende korrekt, was der
// Validator anschliessend verwirft — und man tunte am Prompt herum statt am Bundle.
//
// `muss` traegt einen Namen ODER eine Liste. Eine Liste heisst: dieser Ort gehoert
// mehreren Analysten, jeder aus eigenem Recht -- das ist die gepflanzte Ueberlappung, an
// der sich Clustern und Severity-Erhoehung ueberhaupt messen lassen. `darfNicht` ist die
// Gegenrichtung: dort muss der genannte Analyst schweigen.
//
// Wem ein Konfliktort gehoert, entscheidet seit 0.14.0 die REVIERMATRIX
// (../../REVIERMATRIX.md, eine Quelle statt neun Fragmente). Die Landkarte spiegelt
// deren Zeilen als muss/darfNicht; reviermatrix.test.mjs haelt beide Seiten zusammen.
//
// Was `evidence` zusichert -- und was nicht (entschieden am 13.08., nach zwei Messlaeufen):
// Zugesichert und maschinell geprueft ist, dass das Zitat auffindbar und seine Zeile
// kommentierbar ist -- der Fall KANN genau so gemeldet werden. NICHT zugesichert ist, dass
// der Analyst dort verankert: in 3 von 13 Faellen des Messlaufs zitierte er eine andere
// Zeile und fand die Sache trotzdem. Seit die Cluster-Achse das Zitat ist, entscheidet die
// Ankerwahl auch ueber Verschmelzung -- deshalb ist die Zusicherung einer muss-Liste die
// FUND-Ebene (jeder Genannte meldet den Fall, der Abgleich legt "anders verankert" zur
// Beurteilung von Hand vor), nicht die Verschmelzung zu einem Cluster. Ob Verschmelzung
// und Eskalation richtig rechnen, prueft cluster.test.mjs deterministisch; ein
// probabilistischer Lauf misst das nicht. Nur wo der PROMPT den Anker vorschreibt (etwa
// gate-integrity und die name:-Zeile), ist die Evidenz wieder eine Zusicherung.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { commentableRanges } from '../../lib/diff.mjs';

// ---------------------------------------------------------------- geaenderte Dateien

const ORDER_SERVICE = [
  'package app;',
  '',
  'import java.util.HashMap;',
  'import java.util.Map;',
  '',
  'public class OrderService {',
  '',
  '  private final Map<String, Order> cache = new HashMap<>();',
  '  private final OrderRepository repository;',
  '',
  '  public OrderService(OrderRepository repository) {',
  '    this.repository = repository;',
  '  }',
  '',
  '  public Order load(String id) {',
  '    if (cache.containsKey(id)) {',
  '      return cache.get(id);',
  '    }',
  // Inline-Normalisierung statt des Ids.normalize der Nachbarn: der gepflanzte
  // consistency-Fall. Bewusst OHNE Framework-Mittel und OHNE Regel in conventions.md --
  // das Muster ist ausschliesslich in der Nachbarschaft belegt (K1-Kette, letzte Stufe
  // vor dem Framework: nur-Nachbarschaft gehoert consistency).
  '    Order order = repository.findById(id.trim().toLowerCase());',
  '    cache.put(id, order);',
  '    return order;',
  '  }',
  '',
  '  public void expireStale() {',
  '    cache.entrySet().removeIf(e -> e.getValue().ageMinutes() > 4500);',
  '  }',
  '',
  '  public Order handle(Order order) {',
  '    if (order.isExpired()) {',
  '      throw new IllegalStateException("expired");',
  '    }',
  '    return repository.save(order);',
  '  }',
  '}',
];

const ORDER_CONTROLLER = [
  'package app;',
  '',
  'import org.springframework.security.access.prepost.PreAuthorize;',
  'import org.springframework.web.bind.annotation.GetMapping;',
  'import org.springframework.web.bind.annotation.PathVariable;',
  'import org.springframework.web.bind.annotation.RestController;',
  '',
  '@RestController',
  'public class OrderController {',
  '',
  '  private final OrderService service;',
  '',
  '  public OrderController(OrderService service) {',
  '    this.service = service;',
  '  }',
  '',
  '  @PreAuthorize("hasRole(\'CLERK\')")',
  '  @GetMapping("/orders/{id}")',
  '  public Order byId(@PathVariable String id) {',
  '    return service.load(id);',
  '  }',
  '',
  '  @GetMapping("/orders/{id}/history")',
  '  public Order history(@PathVariable String id) {',
  '    return service.load(id);',
  '  }',
  '}',
];

const ORDER_LIST_VUE = [
  '<script setup lang="ts">',
  "import { ref, watch } from 'vue'",
  '',
  'const props = defineProps<{ orders: Order[] }>()',
  'const total = ref(0)',
  '',
  'watch(() => props.orders, (list) => {',
  '  total.value = list.reduce((sum, o) => sum + o.amount, 0)',
  '}, { deep: true })',
  '</script>',
  '',
  '<template>',
  '  <ul>',
  '    <li v-for="(order, index) in props.orders" :key="index">',
  '      {{ order.id }} — Gesamtsumme: {{ total }}',
  '    </li>',
  '  </ul>',
  '</template>',
];

const RELEASE_WORKFLOW = [
  'name: Release',
  '',
  'on:',
  '  pull_request_target:',
  '',
  'permissions: write-all',
  '',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with:',
  '          ref: ${{ github.event.pull_request.head.sha }}',
  '      - run: echo "Titel ${{ github.event.pull_request.title }}"',
  '      - run: npm ci && npm run build',
];

// Die Testdatei wird GEAENDERT, nicht neu angelegt: nur so entsteht eine entfernte
// Zeile, an der sich die LEFT-Seite und die Abgrenzung gate-integrity/test-substance
// pruefen laesst.
const ORDER_SERVICE_TEST = [
  'package app;',
  '',
  'import org.junit.jupiter.api.Disabled;',
  'import org.junit.jupiter.api.Test;',
  '',
  'class OrderServiceTest {',
  '',
  '  @Disabled("flaky")',
  '  @Test',
  '  void rejectsExpiredOrder() {',
  '    assertTrue(true);',
  '  }',
  '',
  '  @Test',
  '  void appliesDiscount() {',
  '    var result = service.handle(new Order(10));',
  '    assertNotNull(result);',
  '  }',
  '}',
];

const TEST_PATCH = [
  '@@ -1,11 +1,19 @@',
  ' package app;',
  ' ',
  '+import org.junit.jupiter.api.Disabled;',
  ' import org.junit.jupiter.api.Test;',
  ' ',
  ' class OrderServiceTest {',
  ' ',
  '+  @Disabled("flaky")',
  '   @Test',
  '   void rejectsExpiredOrder() {',
  '-    assertEquals(REJECTED, service.handle(expired));',
  '+    assertTrue(true);',
  '   }',
  '+',
  '+  @Test',
  '+  void appliesDiscount() {',
  '+    var result = service.handle(new Order(10));',
  '+    assertNotNull(result);',
  '   }',
  ' }',
].join('\n');

// Eine neue Datei ist ein Hunk aus lauter hinzugefuegten Zeilen. Damit ist jede Zeile
// kommentierbar, und die gepflanzten Faelle koennen ueberall liegen.
function addedPatch(lines) {
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

// ------------------------------------------------------------ unveraenderter Kontext

// Nachbarn von OrderService. Sie tragen ZWEI Muster, und beide brauchen zwei
// Sichtungen (consistencys eigene Regel: ein Muster ist erst ein Muster, wenn man es
// zweimal sieht): das Result-Muster stuetzt die geschriebene Konvention, die
// Ids.normalize-Aufrufe belegen das UNGESCHRIEBENE Muster fuer den gepflanzten
// consistency-Fall -- es steht absichtlich NICHT in conventions.md.
const INVOICE_SERVICE = [
  'package app;',
  '',
  'public class InvoiceService {',
  '',
  '  private final InvoiceRepository repository;',
  '',
  '  public InvoiceService(InvoiceRepository repository) {',
  '    this.repository = repository;',
  '  }',
  '',
  '  public Invoice load(String id) {',
  '    return repository.findById(Ids.normalize(id));',
  '  }',
  '',
  '  public Result<Invoice> handle(Invoice invoice) {',
  '    if (invoice.isExpired()) {',
  '      return Result.failure("expired");',
  '    }',
  '    return Result.success(repository.save(invoice));',
  '  }',
  '}',
].join('\n');

const PAYMENT_SERVICE = [
  'package app;',
  '',
  'public class PaymentService {',
  '',
  '  private final PaymentRepository repository;',
  '',
  '  public PaymentService(PaymentRepository repository) {',
  '    this.repository = repository;',
  '  }',
  '',
  '  public Payment load(String id) {',
  '    return repository.findById(Ids.normalize(id));',
  '  }',
  '',
  '  public Result<Payment> handle(Payment payment) {',
  '    if (payment.isExpired()) {',
  '      return Result.failure("expired");',
  '    }',
  '    return Result.success(repository.save(payment));',
  '  }',
  '}',
].join('\n');

// Die Definition der gemeinsamen Hilfsfunktion. Als Sibling sichtbar, damit consistency
// nicht nur zwei Aufrufe sieht, sondern auch, dass es GENAU dieselbe Aufgabe ist.
const IDS = [
  'package app;',
  '',
  'final class Ids {',
  '',
  '  private Ids() {}',
  '',
  '  // Bezeichner kommen aus Fremdsystemen mit wechselnder Schreibung; genau eine',
  '  // Stelle normalisiert sie.',
  '  static String normalize(String raw) {',
  '    return raw.trim().toLowerCase();',
  '  }',
  '}',
].join('\n');

// Unveraenderte Testdatei zu OrderController. Sie liegt NUR unter tests/ und ist damit
// nicht zitierbar -- die Sonde fuer test-substance, ob er das beachtet.
const CONTROLLER_TEST = [
  'package app;',
  '',
  'class OrderControllerTest {',
  '',
  '  @Test',
  '  void historyIsReachable() {',
  '    assertNotNull(controller.history("1"));',
  '  }',
  '}',
].join('\n');

const GRADLE = [
  'plugins {',
  '  id("org.springframework.boot") version "3.4.1"',
  '}',
  '',
  'dependencies {',
  '  implementation("org.springframework.boot:spring-boot-starter-web")',
  '  implementation("org.springframework.boot:spring-boot-starter-cache")',
  '  implementation("org.springframework.boot:spring-boot-starter-data-jpa")',
  '  implementation("org.springframework.boot:spring-boot-starter-validation")',
  '  implementation("org.springframework.boot:spring-boot-starter-security")',
  '}',
].join('\n');

const PACKAGE_JSON = JSON.stringify({
  name: 'demo-ui',
  dependencies: { vue: '^3.5.13', pinia: '^2.3.0', 'vue-i18n': '^10.0.5' },
}, null, 2);

const SPEC = [
  '# DEMO-42 — Auftragsübersicht',
  '',
  '1. Ein abgelaufener Auftrag wird abgewiesen.',
  '2. Die Auftragshistorie ist nur für die Rolle CLERK sichtbar.',
  '3. Die Übersicht zeigt die Gesamtsumme der Aufträge.',
].join('\n');

const CONVENTIONS = [
  '# Konventionen',
  '',
  '- Fachliche Fehler werden als `Result<T>` zurückgegeben, nicht geworfen.',
  '- Für Benutzer sichtbare Texte kommen aus der Übersetzung, nie als Literal ins Template.',
].join('\n');

// ------------------------------------------------------------------- die Landkarte

// `muss` = dieser Analyst soll den Fall finden.
// `darfNicht` = Sonde. Findet ihn dieser Analyst, leckt eine Reviergrenze oder er
//               greift in das Revier eines deterministischen Werkzeugs.
export const PLANTED = [
  {
    fall: 'Eigener Cache statt @Cacheable',
    // REVIERMATRIX K2: ein Framework-Nachbau ohne geschriebene Regel gehoert dem
    // Stack-Analysten allein. Gemessen in allen drei Laeufen vom 13.08.: consistency
    // meldete denselben Nachbau aus der Nachbarschaft (der einzige Nachbar ist
    // zustandslos -- EINE Sichtung, nach seiner eigenen Regel kein Muster), und
    // spec-fidelity meldete ihn als ungefragten Zusatz mit einem fix, der dem des
    // Eigentuemers widerspricht (entfernen vs. @Cacheable). Die Sonde haelt beide
    // Abtretungen fest; der bewusste Verlust der "nie beauftragt"-Aussage an
    // Nachbau-Orten steht als Ausnahme in UEBERGABE-pr-review.md.
    muss: 'java-spring',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'private final Map<String, Order> cache = new HashMap<>();',
    line: 8,
    darfNicht: ['consistency', 'spec-fidelity'],
    hinweis: 'spring-boot-starter-cache steht im Manifest — confidence: hoch ist erreichbar.',
  },
  {
    fall: 'Unbegründete Zahl',
    muss: 'rationale',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'cache.entrySet().removeIf(e -> e.getValue().ageMinutes() > 4500);',
    line: 25,
    darfNicht: ['java-spring'],
  },
  {
    fall: 'Wurf gegen die geschriebene Result-Konvention',
    // REVIERMATRIX K1: die Regel steht ausdruecklich in conventions.md, also gehoert
    // der Ort spec-fidelity -- er zitiert die Regel im problem. Bis 0.13.0 stand hier
    // muss: consistency, und in allen drei Messlaeufen vom 13.08. meldeten BEIDE mit
    // derselben Aussage und demselben fix; die daraus verschmolzene Erhoehung auf
    // blocker war in Lauf 2 und 3 die einzige bzw. eine von vier -- jede aus
    // Regel-Doppelbesitz, keine aus echter Mehrfachbetroffenheit. java-spring steht
    // mit in der Sonde, weil er die Datei sieht und seine Abgrenzung geschriebene
    // Konventionen ebenfalls abtritt.
    muss: 'spec-fidelity',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'throw new IllegalStateException("expired");',
    line: 30,
    darfNicht: ['consistency', 'java-spring'],
    hinweis: 'Beleg liegt in conventions.md (Regel) und siblings/ (Muster) — beide nicht zitierbar.',
  },
  {
    fall: 'Inline-Normalisierung neben dem Ids.normalize der Nachbarn',
    // Der neue muss-Fall fuer consistency, nachdem K1 ihm den Result-Ort genommen hat:
    // ein Muster, das NUR in der Nachbarschaft belegt ist (Ids.java plus zwei Aufrufer
    // in siblings/), ohne Regel in conventions.md und ohne Framework-Mittel. Die
    // K1-Kette endet damit bei consistency. java-spring steht in der Sonde, weil seine
    // Abgrenzung die eigene Hilfsfunktion im REPO bereits consistency zuschreibt --
    // String-Operationen sind kein Framework-Mittel.
    muss: 'consistency',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'Order order = repository.findById(id.trim().toLowerCase());',
    line: 19,
    darfNicht: ['java-spring'],
  },
  {
    fall: 'Endpunkt ohne Autorisierung, Vergleichsfall in derselben Datei',
    muss: 'security-context',
    file: 'src/main/java/app/OrderController.java',
    evidence: 'public Order history(@PathVariable String id) {',
    line: 24,
    // Der alte Hinweis ("der einzige Ort, an dem die Eskalation ausgeloest werden
    // kann") stimmt seit der Konkordanz-Regel nicht mehr: Erhoehung verlangt zwei
    // Analysten UNABHAENGIG auf der Basisstufe, und security-context (Deckel blocker)
    // kann mit spec-fidelity oder test-substance (Deckel major) nie uebereinstimmen.
    hinweis: 'ERWÜNSCHTE ÜBERLAPPUNG (REVIERMATRIX U1) mit spec-fidelity (Kriterium 2) '
      + 'und test-substance (Erreichbarkeitstest) — zugesichert auf der Fund-Ebene, '
      + 'nicht als Cluster. Eine Erhöhung kann hier seit der Konkordanz-Regel nicht '
      + 'mehr entstehen (Deckel blocker vs. major).',
  },
  {
    fall: 'Akzeptanzkriterium 2 nicht umgesetzt',
    muss: 'spec-fidelity',
    file: 'src/main/java/app/OrderController.java',
    evidence: '@GetMapping("/orders/{id}/history")',
    line: 23,
  },
  {
    fall: 'Test stillgelegt',
    muss: 'gate-integrity',
    file: 'src/test/java/app/OrderServiceTest.java',
    evidence: '@Disabled("flaky")',
    line: 8,
    darfNicht: ['test-substance'],
  },
  {
    fall: 'Assertion im Diff abgeschwächt',
    muss: 'gate-integrity',
    file: 'src/test/java/app/OrderServiceTest.java',
    evidence: 'assertEquals(REJECTED, service.handle(expired));',
    line: 9,
    side: 'LEFT',
    darfNicht: ['test-substance'],
    hinweis: 'Entfernte Zeile: Zitat stammt aus dem Patch, nicht aus files/.',
  },
  {
    fall: 'Assertionsarmer neuer Test',
    muss: 'test-substance',
    file: 'src/test/java/app/OrderServiceTest.java',
    evidence: 'assertNotNull(result);',
    line: 17,
  },
  {
    fall: 'watch, wo computed hingehört',
    muss: 'vue-ts',
    file: 'src/ui/OrderList.vue',
    evidence: 'watch(() => props.orders, (list) => {',
    line: 7,
  },
  {
    fall: 'Sichtbares Literal gegen die geschriebene i18n-Konvention',
    // REVIERMATRIX K1, zweiter Konventionsort -- bis 0.13.0 gar nicht gepflanzt und
    // trotzdem in allen drei Laeufen von DREI Analysten gemeldet (consistency,
    // spec-fidelity, vue-ts), alle mit derselben Regel aus conventions.md und
    // demselben fix. Ob die Erhoehung feuerte, hing nur daran, ob zwei der drei
    // zufaellig dieselbe Severity wuerfelten (Lauf 2: ja, blocker; Lauf 3: nein).
    // Der Eigentuemer nennt das Framework-Mittel im fix; vue-i18n steht im Manifest.
    muss: 'spec-fidelity',
    file: 'src/ui/OrderList.vue',
    evidence: '{{ order.id }} — Gesamtsumme: {{ total }}',
    line: 15,
    darfNicht: ['consistency', 'vue-ts'],
  },
  {
    fall: 'key am Index bei umsortierbarer Liste',
    muss: 'vue-ts',
    file: 'src/ui/OrderList.vue',
    evidence: '<li v-for="(order, index) in props.orders" :key="index">',
    line: 14,
  },
  {
    fall: 'pull_request_target mit Checkout des PR-Standes',
    // Zwei Namen, und beide zu Recht: workflow-ci sieht den Ausloeser samt Checkout des
    // Fork-Standes, security-context sieht den geoeffneten Weg -- Fork-Code laeuft mit den
    // Rechten des Zielrepos. Das ist NICHT die ${{ }}-Injection zwei Zeilen weiter unten;
    // die gehoert actionlint und steht als eigene Sonde in dieser Liste.
    //
    // Der Eintrag ist zugleich die einzige gepflanzte Ueberlappung des Bundles. Seit der
    // Cluster-Schluessel das Zitat ist, entsteht Ueberlappung nur noch aus einem
    // GETEILTEN Zitat; vorher genuegten drei Zeilen Abstand, und die Zusicherung "dieses
    // Bundle kann Ueberlappung ueberhaupt ausloesen" hing damit an der Toleranz statt an
    // der Landkarte. Im ersten Messlauf vom 13.08. zitierten beide Analysten diese Zeile;
    // im zweiten verankerte workflow-ci auf Z16 (npm ci) und fand die Sache trotzdem.
    // Zugesichert ist hier deshalb die FUND-Ebene: beide melden den Fall. Ob sie im Lauf
    // dasselbe Zitat waehlen und verschmelzen, ist Vorhersage -- die Verschmelzungs- und
    // Eskalationsrechnung selbst prueft cluster.test.mjs deterministisch.
    muss: ['workflow-ci', 'security-context'],
    file: '.github/workflows/release.yml',
    evidence: 'ref: ${{ github.event.pull_request.head.sha }}',
    line: 14,
  },
  {
    fall: 'Ungepinnte Third-Party-Action',
    muss: 'workflow-ci',
    file: '.github/workflows/release.yml',
    evidence: '- uses: actions/checkout@v4',
    line: 12,
  },
  {
    fall: 'Neuer CI-Workflow ohne Bezug zum PR-Inhalt — Anker ist die Änderung selbst',
    // Der Fall ist echt und gehoert gate-integrity: ein Release-Workflow in einem PR ueber
    // eine Auftragsuebersicht. Gepflanzt ist hier aber vor allem der ANKER: "ohne Bezug"
    // ist eine getarnte Abwesenheit, und am 13.08. lieh sich der Analyst dafuer
    // permissions: write-all -- die Zeile, die workflow-ci fachlich prueft. Der Prompt
    // schreibt seither die name:-Zeile vor; dieser Eintrag misst, ob das ankommt.
    //
    // REVIERMATRIX K3: gate-integrity ist ALLEINIGER Eigentuemer von "Aenderung ohne
    // Bezug" in CI-Dateien. spec-fidelity meldete denselben Workflow in Lauf 1 und 3
    // als ungefragten Zusatz ("ohne Bezug zu einem Kriterium") -- in Lauf 1 sogar auf
    // derselben name:-Zeile, die dieser Eintrag gate-integrity vorschreibt. Seine
    // Abtretung laeuft hart ueber den Dateipfad (.github/workflows/ usw.); bewusste
    // Deckel-Folge, entschieden in der Matrix: der Ort wird blocker-faehig.
    muss: 'gate-integrity',
    file: '.github/workflows/release.yml',
    evidence: 'name: Release',
    line: 1,
    darfNicht: ['spec-fidelity'],
  },
  {
    fall: 'Rechte weiter als nötig (write-all) — die Zeile gehört workflow-ci allein',
    // Die Gegenseite desselben Falls, gemessen am 13.08.: workflow-ci meldete write-all
    // zu Recht (major), gate-integrity zitierte dieselbe Zeile fuer seinen
    // ohne-Bezug-Befund -- gemeinsames Cluster, Erhoehung auf blocker. Die Sonde haelt
    // fest, dass die Zeile nur EINEM gehoert. Schlaegt sie an, ist der geliehene Anker
    // zurueck und die Severity-Erhoehung feuert wieder auf einer Verschmelzung, die
    // keine Mehrfachbetroffenheit ist.
    muss: 'workflow-ci',
    file: '.github/workflows/release.yml',
    evidence: 'permissions: write-all',
    line: 6,
    darfNicht: ['gate-integrity'],
  },
  {
    fall: 'Injection über ${{ }} in einem run-Block',
    muss: null,
    file: '.github/workflows/release.yml',
    evidence: '- run: echo "Titel ${{ github.event.pull_request.title }}"',
    line: 15,
    // Zwei Namen, weil die Sonde mit einem Namen den Leck nicht gefunden hat: im Messlauf
    // vom 13.08. verschwieg workflow-ci die Stelle korrekt, security-context meldete sie
    // als blocker -- und die Sonde sagte nichts, weil sie nur nach workflow-ci sah. Eine
    // Sonde ist nur so gut wie ihre Liste. Wer einen Ort einem deterministischen Werkzeug
    // zuschlaegt, muss JEDEN Analysten nennen, der ihn sehen kann, nicht nur den
    // naechstliegenden.
    darfNicht: ['workflow-ci', 'security-context'],
    hinweis: 'SONDE: actionlint prüft das deterministisch. Meldet einer der beiden es '
      + 'trotzdem, ist Prinzip 2 im Prompt nicht angekommen.',
  },
  {
    fall: 'Komponente ohne Testdatei — gehört der Bilanz, nicht dem Roster',
    muss: null,
    file: 'src/ui/OrderList.vue',
    evidence: 'total.value = list.reduce((sum, o) => sum + o.amount, 0)',
    line: 8,
    // SONDE fuer einen geliehenen Anker. OrderList.vue hat keine Testdatei; der Bundle-Bau
    // vermerkt das in meta.missing_tests, und die Bilanz fuehrt es unter "Luecken in der
    // Eingabe" auf. gate-integrity meldete es am 13.08. trotzdem als Inline-Befund -- und
    // musste sich dafuer einen Anker leihen, weil meta.json nicht zitierbar ist. Er nahm
    // ausgerechnet die Zeile, die vue-ts fuer seinen Reaktivitaetsbefund zitiert.
    //
    // Seit Cluster nach dem Zitat gebildet werden, ist das nicht mehr nur unschoen: beide
    // Befunde landen in EINEM Kommentar, und weil beide major sind, erhoeht die
    // Uebereinstimmungsregel auf blocker. Ein geliehener Anker erzeugt jetzt also eine
    // falsche Severity, nicht bloss eine falsche Nachbarschaft.
    // Zwei Namen, und der zweite kam nicht aus dem Messlauf, sondern aus dem
    // Invariantentest: test-substance verwies fuer diesen Fall auf gate-integrity als
    // Eigentuemer. Nachdem gate-integrity ihn abgegeben hat, zeigte dieser Verweis auf
    // niemanden mehr -- und ein Analyst, der auf einen leeren Eigentuemer verweist, greift
    // beim naechsten Lauf selbst zu. Die Grenzen sind paarweise geschrieben; wer eine
    // aufloest, muss die Gegenseite mitnehmen.
    darfNicht: ['gate-integrity', 'test-substance'],
    hinweis: 'SONDE: ein Befund über eine ABWESENHEIT hat keinen eigenen Anker. Meldet '
      + 'einer der beiden hier etwas, hat er sich eine Zeile geliehen, die vue-ts gehört.',
  },
];

// ------------------------------------------------------------------------ schreiben

const FILES = [
  { path: 'src/main/java/app/OrderService.java', lines: ORDER_SERVICE, status: 'added' },
  { path: 'src/main/java/app/OrderController.java', lines: ORDER_CONTROLLER, status: 'added' },
  { path: 'src/ui/OrderList.vue', lines: ORDER_LIST_VUE, status: 'added' },
  { path: '.github/workflows/release.yml', lines: RELEASE_WORKFLOW, status: 'added' },
];

function write(dir, rel, content) {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function makeBundleB(dir) {
  const metaFiles = [];
  const patchParts = [];

  for (const f of FILES) {
    const text = `${f.lines.join('\n')}\n`;
    const patch = addedPatch(f.lines);
    write(dir, join('files', f.path), text);
    write(dir, join('patches', `${f.path}.patch`), patch);
    patchParts.push(`--- a/${f.path}\n+++ b/${f.path}\n${patch}`);
    metaFiles.push({
      path: f.path, status: f.status, additions: f.lines.length, deletions: 0,
      commentable: commentableRanges(patch),
    });
  }

  const testPath = 'src/test/java/app/OrderServiceTest.java';
  write(dir, join('files', testPath), `${ORDER_SERVICE_TEST.join('\n')}\n`);
  write(dir, join('patches', `${testPath}.patch`), TEST_PATCH);
  patchParts.push(`--- a/${testPath}\n+++ b/${testPath}\n${TEST_PATCH}`);
  metaFiles.push({
    path: testPath, status: 'modified', additions: 8, deletions: 1,
    commentable: commentableRanges(TEST_PATCH),
  });

  write(dir, 'siblings/src/main/java/app/Ids.java', `${IDS}\n`);
  write(dir, 'siblings/src/main/java/app/InvoiceService.java', `${INVOICE_SERVICE}\n`);
  write(dir, 'siblings/src/main/java/app/PaymentService.java', `${PAYMENT_SERVICE}\n`);
  write(dir, 'tests/src/test/java/app/OrderControllerTest.java', `${CONTROLLER_TEST}\n`);
  write(dir, 'manifests/build.gradle.kts', `${GRADLE}\n`);
  write(dir, 'manifests/package.json', `${PACKAGE_JSON}\n`);
  write(dir, 'spec.md', `${SPEC}\n`);
  write(dir, 'conventions.md', `${CONVENTIONS}\n`);
  write(dir, 'previous.json', '[]');
  write(dir, 'diff.patch', patchParts.join('\n'));

  write(dir, 'meta.json', JSON.stringify({
    repo: 'example/demo',
    number: 42,
    title: 'DEMO-42: Auftragsübersicht',
    body: 'siehe specs/DEMO-42.md',
    author: 'agent',
    labels: [],
    base_sha: 'base',
    head_sha: 'head',
    head_ref: 'feature/DEMO-42-uebersicht',
    spec_link: 'specs/DEMO-42.md',
    spec_missing: false,
    conventions_missing: false,
    missing_tests: ['src/ui/OrderList.vue'],
    siblings: [
      'src/main/java/app/Ids.java',
      'src/main/java/app/InvoiceService.java',
      'src/main/java/app/PaymentService.java',
    ],
    siblings_truncated: [],
    manifests: ['build.gradle.kts', 'package.json'],
    files: metaFiles,
  }, null, 2));

  mkdirSync(join(dir, 'findings'), { recursive: true });
  return dir;
}

if (process.argv[1] && process.argv[1].endsWith('make-bundle-b.mjs')) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Aufruf: node make-bundle-b.mjs <zielverzeichnis>\n');
    process.exit(1);
  }
  makeBundleB(target);
  process.stdout.write(`Bundle B liegt unter ${target}\n`);
  process.stdout.write(`${PLANTED.length} gepflanzte Faelle, davon ${PLANTED.filter((p) => p.darfNicht).length} mit Sonde.\n`);
}
