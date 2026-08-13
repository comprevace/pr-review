import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAnalysts, selectAnalysts, parseFrontmatter } from '../lib/registry.mjs';

const ROOT = join(import.meta.dirname, '..');

test('die generischen Analysten laden fehlerfrei', () => {
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  const names = list.map((a) => a.name).sort();
  assert.deepEqual(names, ['gate-integrity', 'spec-fidelity', 'test-substance']);
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
});

test('alle laufen auch bei einem Diff ohne passende Endung', () => {
  const list = loadAnalysts([join(ROOT, 'analysts')]);
  const { selected, skipped } = selectAnalysts(list, ['README.md']);
  assert.equal(selected.length, 3);
  assert.deepEqual(skipped, []);
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
  assert.match(contract, /\*\*`tests\/`, `spec\.md` und `conventions\.md` sind nicht zitierbar\.\*\*/);
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
