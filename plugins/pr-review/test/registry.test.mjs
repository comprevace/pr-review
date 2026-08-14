import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, loadAnalysts, selectAnalysts } from '../lib/registry.mjs';

const DOC = `---
name: gate-integrity
title: Gate-Integrität
when: paths
paths: ["**/*.java", ".github/workflows/**"]
severity_max: blocker
model: sonnet
---
## Deine Blickrichtung
Alles.
`;

test('parseFrontmatter liest Skalare und String-Arrays', () => {
  const { meta, body } = parseFrontmatter(DOC);
  assert.equal(meta.name, 'gate-integrity');
  assert.equal(meta.title, 'Gate-Integrität');
  assert.equal(meta.when, 'paths');
  assert.deepEqual(meta.paths, ['**/*.java', '.github/workflows/**']);
  assert.equal(meta.severity_max, 'blocker');
  assert.equal(meta.model, 'sonnet');
  assert.ok(body.startsWith('## Deine Blickrichtung'));
});

test('parseFrontmatter wirft bei fehlendem Frontmatter', () => {
  assert.throws(() => parseFrontmatter('kein frontmatter'), /Frontmatter/);
});

test('parseFrontmatter wirft bei unbekanntem Schluessel', () => {
  const bad = '---\nname: x\ntitle: X\nwhen: always\nsevrity_max: blocker\n---\nbody\n';
  assert.throws(() => parseFrontmatter(bad), /sevrity_max/);
});

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'prr-reg-'));
  mkdirSync(join(root, 'analysts'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'analysts', name), content);
  }
  return join(root, 'analysts');
}

const ALWAYS = (name, title, sev = 'major') =>
  `---\nname: ${name}\ntitle: ${title}\nwhen: always\nseverity_max: ${sev}\n---\nBody ${name}\n`;

test('loadAnalysts liest beide Wurzeln, repo-lokal gewinnt bei Namensgleichheit', () => {
  const plugin = makeRoot({ 'a.md': ALWAYS('a', 'Plugin-A'), 'b.md': ALWAYS('b', 'Plugin-B') });
  const repo = makeRoot({ 'a.md': ALWAYS('a', 'Repo-A', 'blocker') });
  const list = loadAnalysts([plugin, repo]);
  const byName = new Map(list.map((x) => [x.name, x]));
  assert.equal(list.length, 2);
  assert.equal(byName.get('a').title, 'Repo-A');
  assert.equal(byName.get('a').severity_max, 'blocker');
  assert.equal(byName.get('a').source, 'repo');
  assert.equal(byName.get('b').source, 'plugin');
});

test('loadAnalysts wirft, wenn name nicht zum Dateinamen passt', () => {
  const root = makeRoot({ 'x.md': ALWAYS('y', 'Y') });
  assert.throws(() => loadAnalysts([root]), /x\.md/);
});

test('loadAnalysts ueberspringt Dateien ohne Frontmatter-Kopf', () => {
  // Die README im Projekt-Analystenverzeichnis ist Anleitung, kein Analyst.
  // Sie als Analyst zu lesen brach `post` ab -- und zwar erst, nachdem alle
  // Subagenten schon gelaufen waren.
  const root = makeRoot({
    'README.md': '# Projektspezifische Analysten\n\nAufbau steht im Kontrakt.\n',
    'a.md': ALWAYS('a', 'A'),
  });
  assert.deepEqual(loadAnalysts([root]).map((x) => x.name), ['a']);
});

test('eine Datei MIT Frontmatter-Kopf scheitert weiterhin laut', () => {
  // Die Grenze des Ueberspringens: ein unabgeschlossener Kopf ist ein Fehler,
  // kein Dokument. Sonst liesse ein Tippfehler den Analysten still ausfallen --
  // genau das, was die Frontmatter-Pruefung verhindern soll.
  const root = makeRoot({ 'broken.md': '---\nname: broken\ntitle: B\n' });
  assert.throws(() => loadAnalysts([root]), /broken\.md/);
  assert.throws(() => loadAnalysts([root]), /Frontmatter/);
});

test('ein unbekannter Frontmatter-Schluessel nennt die Datei', () => {
  const root = makeRoot({
    'typo.md': '---\nname: typo\ntitle: T\nwhen: always\nsevrity_max: major\n---\nB\n',
  });
  assert.throws(() => loadAnalysts([root]), /typo\.md/);
  assert.throws(() => loadAnalysts([root]), /sevrity_max/);
});

test('Brace-Glob mit Komma im Zitat bleibt unversehrt', () => {
  const doc = '---\nname: vue\ntitle: Vue\nwhen: paths\npaths: ["**/*.{vue,ts}", "src/**"]\nseverity_max: major\n---\nB\n';
  const { meta } = parseFrontmatter(doc);
  assert.deepEqual(meta.paths, ['**/*.{vue,ts}', 'src/**']);
});

test('ein Brace-Glob greift danach auf beide Endungen', () => {
  const root = makeRoot({
    'vue.md': '---\nname: vue\ntitle: Vue\nwhen: paths\npaths: ["**/*.{vue,ts}"]\nseverity_max: major\n---\nB\n',
  });
  const analysts = loadAnalysts([root]);
  assert.equal(selectAnalysts(analysts, ['src/Foo.vue']).selected.length, 1);
  assert.equal(selectAnalysts(analysts, ['src/Foo.ts']).selected.length, 1);
  assert.equal(selectAnalysts(analysts, ['README.md']).selected.length, 0);
});

test('selectAnalysts nimmt always immer und paths nur bei Treffer', () => {
  const root = makeRoot({
    'core.md': ALWAYS('core', 'Kern'),
    'java.md': '---\nname: java\ntitle: Java\nwhen: paths\npaths: ["**/*.java"]\nseverity_max: major\n---\nB\n',
    'wf.md': '---\nname: wf\ntitle: Workflow\nwhen: paths\npaths: [".github/workflows/**"]\nseverity_max: major\n---\nB\n',
  });
  const analysts = loadAnalysts([root]);
  const { selected, skipped } = selectAnalysts(analysts, ['src/A.java', 'README.md']);
  assert.deepEqual(selected.map((a) => a.name).sort(), ['core', 'java']);
  assert.deepEqual(skipped, [{ name: 'wf', reason: 'kein Pfad im Diff passt auf .github/workflows/**' }]);
});
