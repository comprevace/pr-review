import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAnalysts, selectAnalysts } from '../lib/registry.mjs';
import { PLANTED } from './fixtures/make-bundle-b.mjs';

// Die Reviermatrix ist EINE zentral entschiedene Quelle (REVIERMATRIX.md), aber kein
// Analyst liest sie: jeder sieht nur Kontrakt + eigene Datei. Jede Matrix-Zeile muss
// deshalb in den betroffenen Prompts gespiegelt sein -- und jede Grenze in Bundle B
// eine Sonde tragen. Diese Datei haelt alle drei Seiten zusammen. Sie prueft als
// Gleichung, nicht als feste Liste, wo das geht: wer im Prompt abtritt, muss in der
// Sonde stehen, und wer in der Sonde steht, muss im Prompt abtreten. Beide Richtungen
// sind ein echter Fehlerfall (Prompt-Fix ohne Sonde: der Rueckfall wird nie bemerkt;
// Sonde ohne Prompt-Fix: sie schlaegt bei jedem Lauf an, und irgendwann glaubt ihr
// niemand mehr).
//
// Die Datei liegt NICHT unter analysts/: die Registry laedt dort jede .md als
// Analysten und wuerde an einer Datei ohne Analysten-Frontmatter laut scheitern.

const ROOT = join(import.meta.dirname, '..');
const MATRIX_PATH = join(ROOT, 'REVIERMATRIX.md');
const analysts = loadAnalysts([join(ROOT, 'analysts')]);
const byName = new Map(analysts.map((a) => [a.name, a]));

const blick = (name) => byName.get(name).body.split('NICHT deine Sache')[0];
const abgrenzung = (name) => byName.get(name).body.split('NICHT deine Sache')[1] ?? '';
const mussListe = (p) => (p.muss === null || p.muss === undefined ? [] : [p.muss].flat());
const matrix = existsSync(MATRIX_PATH) ? readFileSync(MATRIX_PATH, 'utf8') : '';

test('die Reviermatrix existiert als eine Quelle und traegt alle Zeilen', () => {
  assert.ok(matrix.length > 0, 'REVIERMATRIX.md fehlt neben analyst-contract.md');
  // Konfliktklassen mit genau einem Eigentuemer UND erwuenschte Ueberlappungen --
  // die Matrix muss beide Klassen ausdruecklich unterscheiden.
  for (const zeile of ['K1', 'K2', 'K3', 'U1', 'U2', 'U3', 'U4']) {
    assert.match(matrix, new RegExp(`\\b${zeile}\\b`), `Matrix-Zeile ${zeile} fehlt`);
  }
  // Jeder Analyst des Rosters kommt vor: eine Matrix, die einen Analysten nicht
  // einordnet, laesst genau die unentschiedene Grenze offen, die sie schliessen soll.
  for (const a of analysts) {
    assert.match(matrix, new RegExp(`\`${a.name}\``), `Matrix ordnet ${a.name} nicht ein`);
  }
});

test('Option C steht in der Matrix als dokumentiert dagegen entschieden', () => {
  // Sie repariert die Statistik statt der Ursache und braucht eine Aggregations-
  // aenderung. Sie steht trotzdem drin, damit die Entscheidung DAGEGEN nachlesbar
  // ist -- sonst schlaegt sie jemand in einem Jahr erneut vor.
  assert.match(matrix, /Option C/);
  assert.match(matrix, /verworfen|dagegen entschieden/i);
});

// ---------------------------------------------------------------------------- K1

test('K1: spec-fidelity besitzt die geschriebene Konvention und traegt beide Pflichten', () => {
  const b = blick('spec-fidelity');
  assert.match(b, /conventions\.md/, 'muss conventions.md als sein Bezugsdokument fuehren');
  assert.match(b, /REVIERMATRIX|K1/, 'muss das Eigentum als Matrix-Entscheidung benennen');
  // Die Eigentuemer-Pflichten aus der Entscheidung: Regel im problem, Mittel im fix.
  // Ohne die fix-Pflicht verloere der Kommentar die Framework-Konkretheit, die vorher
  // der Stack-Analyst geliefert hat -- das war das staerkste Argument GEGEN Option A.
  assert.match(b, /Regel im `problem`/, 'muss die Regel-im-problem-Pflicht nennen');
  assert.match(b, /`fix`/, 'muss die Mittel-im-fix-Pflicht nennen');
});

test('K1: die Konventions-Sonden decken genau die Abtretenden, die den Ort sehen', () => {
  // Die Gleichung, an der die actionlint-Luecke damals gerissen ist, hier fuer K1:
  // Wer in seiner Abgrenzung geschriebene Konventionen an spec-fidelity abtritt, muss
  // an jedem Konventionsort, den er sehen kann, in der Sonde stehen -- und umgekehrt.
  // Eine Sonde mit einem Namen zu wenig findet den Leck nicht (gemessen am 13.08. an
  // der Injection-Sonde, die nur nach workflow-ci sah).
  const abtretende = analysts
    .filter((a) => a.name !== 'spec-fidelity'
      && /conventions\.md/.test(abgrenzung(a.name))
      && /spec-fidelity/.test(abgrenzung(a.name)))
    .map((a) => a.name);
  assert.ok(abtretende.length >= 2,
    'mindestens consistency und die Stack-Analysten muessen die Abtretung tragen');

  const orte = PLANTED.filter((p) => p.muss === 'spec-fidelity' && /Konvention/.test(p.fall));
  assert.equal(orte.length, 2, 'beide Konventionsorte (Result, i18n) muessen gepflanzt sein');

  for (const ort of orte) {
    const sichtbar = new Set(selectAnalysts(analysts, [ort.file]).selected.map((a) => a.name));
    const erwartet = abtretende.filter((n) => sichtbar.has(n)).sort();
    assert.deepEqual([...(ort.darfNicht ?? [])].sort(), erwartet,
      `Sonde an "${ort.fall}" deckt nicht genau die sehenden Abtretenden`);
  }
});

// ---------------------------------------------------------------------------- K2

test('K2: der Stack-Analyst besitzt den Nachbau, consistency und spec-fidelity treten ab', () => {
  const sonde = PLANTED.find((p) => p.fall.includes('@Cacheable'));
  assert.ok(sonde, 'der Cache-Fall fehlt in der Landkarte');
  assert.deepEqual([...(sonde.darfNicht ?? [])].sort(), ['consistency', 'spec-fidelity'],
    'die Cache-Sonde muss beide Abtretenden festhalten');

  // Beide Abtretungen nennen den Empfaenger BEIM NAMEN -- ein Verweis auf niemanden
  // ist der Fehler, der hier schon zweimal passiert ist.
  assert.match(abgrenzung('consistency'), /java-spring/, 'consistency muss den Java-Empfaenger nennen');
  assert.match(abgrenzung('consistency'), /vue-ts/, 'consistency muss den Vue-Empfaenger nennen');
  assert.match(abgrenzung('spec-fidelity'), /Nachbau/, 'spec-fidelity muss den Nachbau-Fall abtreten');
  assert.match(abgrenzung('spec-fidelity'), /java-spring/, 'spec-fidelity muss den Java-Empfaenger nennen');
  assert.match(abgrenzung('spec-fidelity'), /vue-ts/, 'spec-fidelity muss den Vue-Empfaenger nennen');

  // Die Eigentuemer behaupten das Recht in der Blickrichtung -- sonst glaubt der
  // Analyst der Abtretung des Nachbarn mehr als dem eigenen Auftrag und schweigt.
  assert.match(blick('java-spring'), /REVIERMATRIX|K2/, 'java-spring muss das Eigentum behaupten');
  assert.match(blick('vue-ts'), /REVIERMATRIX|K2/, 'vue-ts muss das Eigentum behaupten');

  // Der bewusste Verlust der "nie beauftragt"-Aussage ist eine dokumentierte
  // Ausnahme, keine stille -- die Matrix muss sie tragen.
  assert.match(matrix, /beauftragt|Ungefragt|ungefragt/, 'die K2-Ausnahme fehlt in der Matrix');
});

// ---------------------------------------------------------------------------- K3

test('K3: gate-integrity besitzt die Aenderung ohne Bezug in CI-Dateien allein', () => {
  const anker = PLANTED.find((p) => mussListe(p).includes('gate-integrity')
    && p.file === '.github/workflows/release.yml');
  assert.ok(anker, 'der Workflow-ohne-Bezug-Fall fehlt in der Landkarte');
  assert.ok((anker.darfNicht ?? []).includes('spec-fidelity'),
    'spec-fidelity muss am name:-Fall in der Sonde stehen -- er meldete den Ort in Lauf 1 und 3');

  // Die Abtretung laeuft hart ueber den Dateipfad, nicht ueber eine Einschaetzung --
  // weiche Grenzen ("wenn es wie CI aussieht") haben hier schon Luecken gerissen.
  const a = abgrenzung('spec-fidelity');
  assert.match(a, /\.github\/workflows\//, 'spec-fidelity muss den Pfad als harte Grenze nennen');
  assert.match(a, /gate-integrity/, 'spec-fidelity muss den Empfaenger nennen');

  // Die Deckel-Folge ist Teil der Entscheidung: der Ort wird blocker-faehig, weil der
  // Eigentuemer blocker rufen darf, wo der Abtretende bei major deckelte. Das steht
  // als bewusste Entscheidung in der Matrix, nicht als Nebenwirkung.
  assert.match(matrix, /blocker/, 'die Deckel-Folge fehlt in der Matrix');
});

// ------------------------------------------------------------------- U-Zeilen

test('U1/U2: die gepflanzten erwuenschten Ueberlappungen bleiben zugesichert', () => {
  // Keine neue Abgrenzung darf die erwuenschten Ueberlappungen leiser machen. Die
  // Zusicherung liegt auf der FUND-Ebene (Kopf von make-bundle-b.mjs) -- hier steht,
  // dass die Landkarte sie weiterhin verlangt.
  const prTarget = PLANTED.find((p) => p.fall.includes('pull_request_target'));
  assert.deepEqual([...mussListe(prTarget)].sort(), ['security-context', 'workflow-ci'],
    'U2 (pull_request_target) muss beiden gehoeren, jedem aus eigenem Recht');

  const history = PLANTED.find((p) => p.fall.includes('Endpunkt ohne Autorisierung'));
  assert.equal(mussListe(history)[0], 'security-context', 'U1: der offene Weg gehoert security-context');
  const kriterium = PLANTED.find((p) => p.fall.includes('Akzeptanzkriterium 2'));
  assert.equal(mussListe(kriterium)[0], 'spec-fidelity', 'U1: das unerfuellte Kriterium gehoert spec-fidelity');
});

test('U4: rationale nennt die Stack-Analysten als zweite Blickrichtung, nicht als Eigentuemer', () => {
  // "anders" vs. "erklaert" (U3) hat ein Geschwister bekommen: "Nachbau" vs.
  // "erklaert" (U4, Deep-Watch-Fall aus Lauf 3). Erlaubt, nicht zugesichert -- kein
  // muss, keine Sonde. Der Prompt muss die Trennlinie tragen, damit rationale nicht
  // anfaengt, den Nachbau mitzumelden.
  const a = abgrenzung('rationale');
  assert.match(a, /java-spring/, 'rationale muss java-spring in der Trennlinie nennen');
  assert.match(a, /vue-ts/, 'rationale muss vue-ts in der Trennlinie nennen');
  assert.match(matrix, /erlaubt, nicht zugesichert/, 'U4 muss in der Matrix als erlaubt-nicht-zugesichert stehen');
});

// ------------------------------------------------------------------ Leerlaeufer

test('kein Prompt verweist auf den gestrichenen Analysten complexity als Eigentuemer', () => {
  // Der Fehler aus dem wichtigsten Befund: ein Verweis auf einen Eigentuemer, den es
  // nicht (mehr) gibt. Wer auf einen leeren Eigentuemer verweist, greift beim
  // naechsten Lauf selbst zu. complexity wurde beim Roster-Bau bewusst gestrichen;
  // seine Reste ("das ist complexity") zeigten bis 0.13.0 in zwei Prompts auf
  // niemanden. Historische Erwaehnungen ("seit complexity gestrichen wurde") sind
  // erlaubt -- der Verweis ALS EIGENTUEMER nicht.
  for (const a of analysts) {
    assert.doesNotMatch(a.body, /ist\s+`complexity`/,
      `${a.name} verweist auf complexity als Eigentuemer -- den Analysten gibt es nicht`);
  }
});
