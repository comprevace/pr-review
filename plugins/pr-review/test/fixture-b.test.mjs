import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
      confidence: 'high',
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
  assert.deepEqual(bundle.meta.siblings, [
    'src/main/java/app/Ids.java',
    'src/main/java/app/InvoiceService.java',
    'src/main/java/app/PaymentService.java',
  ]);
  assert.deepEqual(bundle.meta.manifests, ['build.gradle.kts', 'package.json']);
  assert.equal(bundle.meta.spec_missing, false);
  assert.equal(bundle.meta.conventions_missing, false);
});

test('der consistency-Fall hat zwei Sichtungen und keine geschriebene Regel', () => {
  // consistencys eigene Regel: ein Muster ist erst ein Muster, wenn man es zweimal
  // sieht. Sein muss-Fall (Inline-Normalisierung) braucht also ZWEI Aufrufer von
  // Ids.normalize in der Nachbarschaft -- und das Muster darf NICHT in conventions.md
  // stehen, sonst gehoerte der Ort nach K1 spec-fidelity und der Fall misst nichts.
  const sichtungen = ['InvoiceService.java', 'PaymentService.java'].filter((name) => {
    const text = bundle.siblingText?.get?.(`src/main/java/app/${name}`)
      ?? readFileSync(join(dir, 'siblings', 'src/main/java/app', name), 'utf8');
    return /Ids\.normalize\(/.test(text);
  });
  assert.equal(sichtungen.length, 2, 'beide Nachbarn muessen Ids.normalize aufrufen');
  const conventions = readFileSync(join(dir, 'conventions.md'), 'utf8');
  assert.doesNotMatch(conventions, /normalis|Normalis|Ids\./,
    'die Normalisierung darf NICHT als geschriebene Regel existieren');
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

test('die actionlint-Sonde und die Prompts nennen dieselben Analysten', () => {
  // Die Luecke vom 13.08. hatte zwei Haelften, und beide waren unbewacht: der Prompt von
  // security-context grenzte die ${{ }}-Injection nicht ab, UND die Sonde sah nur nach
  // workflow-ci. Jede Haelfte allein haette gereicht, um den Doppelbefund zu verhindern --
  // gefehlt haben beide, und kein Test hat es gesagt.
  //
  // Deshalb hier keine feste Liste, sondern eine Gleichung: wer in seiner Abgrenzung
  // actionlint als Eigentuemer nennt, MUSS in der Sonde stehen, und wer in der Sonde steht,
  // MUSS es in seiner Abgrenzung nennen. Beide Richtungen sind ein echter Fehlerfall.
  // Prompt-Fix ohne Sonde heisst: der Rueckfall wird nie bemerkt. Sonde ohne Prompt-Fix
  // heisst: sie schlaegt bei jedem Lauf an, und irgendwann glaubt man ihr nicht mehr.
  const sonde = PLANTED.find((p) => p.fall.includes('Injection über ${{ }}'));
  assert.ok(sonde, 'die Injection-Sonde fehlt in der Landkarte');

  const nennenActionlint = analysts
    .filter((a) => /actionlint/i.test(a.body.split('NICHT deine Sache')[1] ?? ''))
    .map((a) => a.name)
    .sort();

  assert.deepEqual(
    [...sonde.darfNicht].sort(), nennenActionlint,
    'Sonde und Prompts sind auseinandergelaufen: die Sonde prueft nicht dieselben '
    + 'Analysten, die actionlint als Eigentuemer nennen',
  );
});

test('die Sonde fuer den geliehenen Anker deckt sich mit dem Prompt', () => {
  // Dieselbe Gleichung fuer die zweite Haelfte von Befund 4. Ein Befund ueber eine
  // Abwesenheit hat keinen eigenen Anker; wer das in seiner Abgrenzung stehen hat, muss in
  // der Sonde stehen, die es nachprueft.
  const sonde = PLANTED.find((p) => p.fall.includes('ohne Testdatei'));
  assert.ok(sonde, 'die Sonde fuer den geliehenen Anker fehlt in der Landkarte');

  const nennenMissingTests = analysts
    .filter((a) => /missing_tests/.test(a.body.split('NICHT deine Sache')[1] ?? ''))
    .map((a) => a.name)
    .sort();

  assert.deepEqual([...sonde.darfNicht].sort(), nennenMissingTests);
});

test('die Sonde fuer den Workflow-ohne-Bezug-Anker deckt sich mit dem Prompt', () => {
  // Zweite Stelle des geliehenen Ankers, gemessen am 13.08.: gate-integrity zitierte
  // permissions: write-all fuer "Neuer CI-Workflow ohne Bezug zum PR-Inhalt". Anders als
  // bei missing_tests bleibt der Fall ein Inline-Befund -- er traegt eine sichtbare
  // Aenderung, den Workflow selbst. Das Paar aus muss-Eintrag (der vorgeschriebene Anker)
  // und Sonde (die verbotene Zeile) haelt beide Haelften zusammen: faellt der Prompt-Fix,
  // schlaegt die Sonde im Messlauf an; faellt die Sonde, sagt dieser Test es.
  const sonde = PLANTED.find((p) => (p.darfNicht ?? []).includes('gate-integrity')
    && p.file === '.github/workflows/release.yml');
  assert.ok(sonde, 'die write-all-Sonde gegen den geliehenen Anker fehlt in der Landkarte');
  assert.equal(sonde.evidence, 'permissions: write-all');

  const anker = PLANTED.find((p) => mussListe(p).includes('gate-integrity')
    && p.file === '.github/workflows/release.yml');
  assert.ok(anker, 'der muss-Eintrag fuer den vorgeschriebenen Anker fehlt in der Landkarte');
  assert.equal(anker.evidence, 'name: Release');

  // Der Prompt muss genau den Anker vorschreiben, den die Landkarte erwartet -- sonst
  // misst der Messlauf eine Vorhersage statt einer Vorschrift.
  const blick = analystMap.get('gate-integrity').body.split('NICHT deine Sache')[0];
  assert.match(blick, /`name:`/, 'gate-integrity muss die name:-Zeile als Anker vorschreiben');
});
