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
  '    Order order = repository.findById(id);',
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

// Nachbar von OrderService: zeigt das etablierte Muster (Result statt Wurf). Ohne ihn
// koennte consistency den Musterbruch nicht belegen und muesste raten.
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
  '  public Result<Invoice> handle(Invoice invoice) {',
  '    if (invoice.isExpired()) {',
  '      return Result.failure("expired");',
  '    }',
  '    return Result.success(repository.save(invoice));',
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
    muss: 'java-spring',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'private final Map<String, Order> cache = new HashMap<>();',
    line: 8,
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
    fall: 'Wurf, wo die Nachbarschaft Result zurückgibt',
    muss: 'consistency',
    file: 'src/main/java/app/OrderService.java',
    evidence: 'throw new IllegalStateException("expired");',
    line: 30,
    hinweis: 'Beleg liegt in siblings/…/InvoiceService.java und in conventions.md — beide nicht zitierbar.',
  },
  {
    fall: 'Endpunkt ohne Autorisierung, Vergleichsfall in derselben Datei',
    muss: 'security-context',
    file: 'src/main/java/app/OrderController.java',
    evidence: 'public Order history(@PathVariable String id) {',
    line: 24,
    hinweis: 'ÜBERLAPPUNG mit spec-fidelity (Kriterium 2). Der einzige Ort, an dem die '
      + 'Severity-Eskalation ausgelöst werden kann.',
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
    fall: 'key am Index bei umsortierbarer Liste',
    muss: 'vue-ts',
    file: 'src/ui/OrderList.vue',
    evidence: '<li v-for="(order, index) in props.orders" :key="index">',
    line: 14,
  },
  {
    fall: 'pull_request_target mit Checkout des PR-Standes',
    muss: 'workflow-ci',
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
    fall: 'Injection über ${{ }} in einem run-Block',
    muss: null,
    file: '.github/workflows/release.yml',
    evidence: '- run: echo "Titel ${{ github.event.pull_request.title }}"',
    line: 15,
    darfNicht: ['workflow-ci'],
    hinweis: 'SONDE: actionlint prüft das deterministisch. Meldet workflow-ci es trotzdem, '
      + 'ist Prinzip 2 im Prompt nicht angekommen.',
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

  write(dir, 'siblings/src/main/java/app/InvoiceService.java', `${INVOICE_SERVICE}\n`);
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
    siblings: ['src/main/java/app/InvoiceService.java'],
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
