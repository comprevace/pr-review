import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBundleB, PLANTED } from './fixtures/make-bundle-b.mjs';
import { loadBundle } from '../lib/bundle.mjs';
import { loadAnalysts } from '../lib/registry.mjs';
import { validateFinding } from '../lib/findings.mjs';
import { isCommentable } from '../lib/diff.mjs';

const dir = makeBundleB(join(mkdtempSync(join(tmpdir(), 'prr-fixb-')), 'bundle'));
const bundle = loadBundle(dir);
const haystacks = new Map(bundle.meta.files.map((f) => [
  f.path, `${bundle.fileText.get(f.path) ?? ''}\n${bundle.patchText.get(f.path) ?? ''}`]));
const knownFiles = new Set(bundle.meta.files.map((f) => f.path));
const commentable = new Map(bundle.meta.files.map((f) => [f.path, f.commentable]));
const analysts = loadAnalysts([join(import.meta.dirname, '..', 'analysts')]);
const analystMap = new Map(analysts.map((a) => [a.name, a]));

// `muss` ist ein Name oder eine Liste. Ein Ort kann mehreren Analysten gehoeren -- und
// genau daran haengt die einzige Zusicherung, dass dieses Bundle Ueberlappung ausloesen
// kann. Ueberall normalisieren statt an drei Stellen auf den Typ zu pruefen: sonst faellt
// ein Eintrag als Liste durch einen Test und als String durch einen anderen.
const mussListe = (p) => (p.muss === null || p.muss === undefined ? [] : [p.muss].flat());

// Der Kern dieser Datei. Ein Tuning-Bundle, in dem eine gepflanzte Evidenz nicht
// auffindbar oder ihre Zeile nicht kommentierbar ist, ist schlimmer als keins: Der
// Analyst findet den Fall korrekt, der Validator wirft ihn weg, und man sucht den Fehler
// im Prompt. Deshalb laeuft jeder gepflanzte Fall hier durch DIESELBE Maschinerie, die
// ihn im Ernstfall bewertet -- nicht durch eine nachgebaute Pruefung.
test('jede gepflanzte Evidenz ueberlebt den echten Validator', () => {
  for (const p of PLANTED) {
    const analyst = mussListe(p)[0] ?? p.darfNicht[0];
    const result = validateFinding({
      analyst,
      file: p.file,
      line: p.line,
      side: p.side ?? 'RIGHT',
      severity: 'major',
      title: p.fall,
      problem: 'Vom Fixture gepflanzt.',
      evidence: p.evidence,
      fix: 'Vom Fixture gepflanzt.',
      confidence: 'hoch',
    }, { analysts: analystMap, haystacks, knownFiles });

    assert.equal(result.ok, true, `"${p.fall}" faellt durch: ${result.reason}`);
  }
});

test('jede gepflanzte Zeile ist kommentierbar', () => {
  // Sonst landet der Befund in der Bilanz statt am Code, und man haelt das faelschlich
  // fuer ein Prompt-Problem.
  for (const p of PLANTED) {
    const map = commentable.get(p.file);
    assert.ok(map, `keine commentable-Map fuer ${p.file}`);
    assert.equal(
      isCommentable(map, p.side ?? 'RIGHT', p.line), true,
      `"${p.fall}" liegt auf ${p.file}:${p.line} (${p.side ?? 'RIGHT'}) ausserhalb der Hunks`,
    );
  }
});

test('jeder Analyst des Rosters hat mindestens einen Fall oder eine Sonde', () => {
  // Ein Analyst ohne gepflanzten Fall laesst sich an diesem Bundle nicht tunen -- und
  // das faellt beim Tunen nicht auf, sondern sieht aus wie ein stiller Analyst.
  const abgedeckt = new Set();
  for (const p of PLANTED) {
    for (const n of mussListe(p)) abgedeckt.add(n);
    for (const n of p.darfNicht ?? []) abgedeckt.add(n);
  }
  const fehlend = analysts.map((a) => a.name).filter((n) => !abgedeckt.has(n));
  assert.deepEqual(fehlend, [], `ohne Fall im Bundle B: ${fehlend.join(', ')}`);
});

test('die Namen in der Landkarte sind echte Analysten', () => {
  // Ein Tippfehler in PLANTED wuerde den Abdeckungstest oben stillschweigend erfuellen.
  for (const p of PLANTED) {
    for (const name of [...mussListe(p), ...(p.darfNicht ?? [])]) {
      assert.ok(analystMap.has(name), `unbekannter Analyst in der Landkarte: ${name}`);
    }
  }
});

test('das Bundle traegt den Kontext, den die Faelle brauchen', () => {
  // consistency ohne Nachbarn, java-spring ohne Manifest und spec-fidelity ohne Spec
  // koennten ihre Faelle nicht belegen und muessten raten.
  assert.deepEqual(bundle.meta.siblings, ['src/main/java/app/InvoiceService.java']);
  assert.deepEqual(bundle.meta.manifests, ['build.gradle.kts', 'package.json']);
  assert.equal(bundle.meta.spec_missing, false);
  assert.equal(bundle.meta.conventions_missing, false);
});

test('mindestens ein Fall erzeugt eine echte Ueberlappung', () => {
  // Die Severity-Erhoehung ist das einzige Redundanzsignal des Konzepts. Ohne einen Ort,
  // an dem zwei disjunkte Blickrichtungen zusammentreffen, laesst sie sich am Roster
  // nicht messen.
  //
  // Diese Probe stand vorher auf "zwei Faelle liegen hoechstens drei Zeilen auseinander"
  // -- und war damit an die alte Cluster-Achse gebunden, nicht an die Landkarte. Als die
  // Achse auf das Zitat wechselte, blieb der Test gruen und die Zusicherung war weg:
  // Bundle B enthielt keine gepflanzte Ueberlappung mehr, und keine Probe sagte es.
  // Jetzt zaehlt, was das Clustern auch zaehlt -- ein GETEILTES Zitat.
  const proZitat = new Map();
  for (const p of PLANTED) {
    const key = `${p.file}\u0000${p.side ?? 'RIGHT'}\u0000${p.evidence.replace(/\s+/g, ' ').trim()}`;
    if (!proZitat.has(key)) proZitat.set(key, new Set());
    for (const name of mussListe(p)) proZitat.get(key).add(name);
  }
  const geteilt = [...proZitat.entries()].filter(([, namen]) => namen.size >= 2);
  assert.ok(
    geteilt.length >= 1,
    'kein gepflanztes Zitat gehoert zwei Analysten -- das Bundle kann keine Ueberlappung ausloesen',
  );
});
