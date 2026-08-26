import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBundleA } from './fixtures/make-bundle-a.mjs';

// Diese Datei prueft die CLI als Programm, nicht als Modul. Fuer commit_id, fuer die
// selbst erkannten Ausfaelle und fuer die Zweitlauf-Bilanz ist das das einzige ehrliche
// Instrument: die Defekte lagen genau in der Verdrahtung von cmdPost/cmdVerify, und die
// ist von aussen nur ueber einen echten Prozessaufruf zu sehen. `gh` wird dabei durch
// ein Skript auf dem PATH ersetzt -- kein Netz, keine Zugangsdaten.
const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'lib/cli.mjs');

function freshBundle(prefix) {
  return makeBundleA(join(mkdtempSync(join(tmpdir(), prefix)), 'bundle-a'));
}

// Eigenes, leeres Arbeitsverzeichnis: cmdPost sucht Analysten zusaetzlich unter
// <cwd>/.claude/pr-review-analysts. Ohne diese Festlegung haengt das Ergebnis daran, aus
// welchem Verzeichnis die Tests gestartet wurden.
function runCli(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: mkdtempSync(join(tmpdir(), 'prr-cwd-')),
    env: { ...process.env, ...env },
  });
}

function payloadOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8'));
}

test('post schickt commit_id mit', () => {
  // Die Anker sind gegen den head_sha des eingefrorenen Bundles geprueft; GitHub prueft
  // sie ohne commit_id gegen den NEUESTEN Commit des PR. POST /reviews ist
  // all-or-nothing: ein Push zwischen fetch und post verwarf damit das GANZE Review mit
  // 422. Bei einem Werkzeug fuer Coding-Agents ist genau das der Normalfall.
  const dir = freshBundle('prr-cli-post-');
  runCli(['post', '--bundle', dir, '--dry-run']);
  const payload = payloadOf(dir);
  assert.equal(payload.commit_id, 'head');
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 2); // A+B verschmolzen, E eigenstaendig
});

test('ein Analyst ohne Datei und ohne Meldung wird von der CLI selbst benannt', () => {
  // --failed ist der deklarative Weg, aber er haengt daran, dass das orchestrierende
  // Modell daran denkt. Vergisst es das, tauchte der abgestuerzte Analyst in der Bilanz
  // weder unter "gelaufen" noch unter "ausgefallen" auf: das Review behauptete mehr
  // Vollstaendigkeit, als es hatte.
  const dir = freshBundle('prr-cli-missing-');
  rmSync(join(dir, 'findings/spec-fidelity.json'));
  runCli(['post', '--bundle', dir, '--dry-run']);
  const body = payloadOf(dir).body;
  assert.match(body, /failed — spec-fidelity/);
  assert.match(body, /keine Findings-Datei geschrieben/);

  // Gemeldet ist gemeldet: dann steht der brauchbare Grund da und kein Ausfall.
  const declared = freshBundle('prr-cli-declared-');
  rmSync(join(declared, 'findings/spec-fidelity.json'));
  runCli(['post', '--bundle', declared, '--dry-run', '--skipped', 'spec-fidelity:im Tuning-Modus nicht gestartet']);
  const declaredBody = payloadOf(declared).body;
  assert.doesNotMatch(declaredBody, /failed — spec-fidelity/);
  assert.match(declaredBody, /not started — spec-fidelity: im Tuning-Modus nicht gestartet/);
});

test('run.log haelt jeden Lauf fest — das MaRisk-Artefakt aus dem Design existiert', () => {
  // Design 5.2 und 9.4 beschreiben run.log als Artefakt der Nachvollziehbarkeit; bis
  // 0.12.0 schrieb kein Code die Datei -- "steht drin und existiert nicht". Geprueft
  // wird das Format (Zeitstempel + Kommando) und dass ein zweiter Lauf ANHAENGT:
  // fetch, post und verify desselben Bundles muessen EINE Akte ergeben, sonst
  // ueberschreibt der Zweitlauf genau die Zeile, die er nachvollziehbar machen soll.
  const dir = freshBundle('prr-cli-runlog-');
  runCli(['post', '--bundle', dir, '--dry-run']);
  const first = readFileSync(join(dir, 'run.log'), 'utf8').trim().split('\n');
  assert.equal(first.length, 1);
  assert.match(first[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z post /);
  assert.match(first[0], /dry-run/);
  assert.match(first[0], /posted=2/);

  runCli(['post', '--bundle', dir, '--dry-run']);
  const second = readFileSync(join(dir, 'run.log'), 'utf8').trim().split('\n');
  assert.equal(second.length, 2, 'der zweite Lauf muss anhaengen, nicht ueberschreiben');
});

// gh-Ersatz auf dem PATH. Unterscheidet die drei Aufrufe, die der Zweitlauf macht:
// Thread-Abfrage, resolve-Mutation, Review-POST. Der POST-Body wird mitgeschrieben --
// er ist das, worauf es ankommt.
const FAKE_GH = [
  '#!/bin/sh',
  'case "$*" in',
  '  *resolveReviewThread*)',
  '    printf \'%s\' \'{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}\'',
  '    ;;',
  '  *reviewThreads*)',
  '    cat "$PRR_THREADS"',
  '    ;;',
  '  *reviews*)',
  '    cat > "$PRR_CAPTURE"',
  '    printf \'%s\' \'{"id":4711,"html_url":"https://example.invalid/r/4711"}\'',
  '    ;;',
  '  *)',
  '    echo "unerwarteter gh-Aufruf: $*" >&2',
  '    exit 1',
  '    ;;',
  'esac',
  '',
].join('\n');

function fakeGhEnv({ threadsJson }) {
  const home = mkdtempSync(join(tmpdir(), 'prr-gh-'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const threads = join(home, 'threads.json');
  const capture = join(home, 'posted.json');
  writeFileSync(threads, threadsJson);
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, PRR_THREADS: threads, PRR_CAPTURE: capture },
    capture,
  };
}

function resolvedThreadFor(body) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: 'T1', isResolved: true, comments: { nodes: [{ body }] } }],
          },
        },
      },
    },
  });
}

test('der Zweitlauf postet einen Rueckfall, nennt ihn und traegt commit_id und Verworfene mit', () => {
  // Drei Defekte an einem Fall: (1) ein Befund, dessen Thread aufgeloest war und der
  // wieder gemeldet wird, wurde nirgends gepostet und nirgends gezaehlt; (2) die
  // Verworfenen des Zweitlaufs waren mit "rejected: []" fest verdrahtet und
  // verschwanden samt Grund und Analystennamen; (3) commit_id fehlte auch hier.
  const dir = freshBundle('prr-cli-verify-');
  runCli(['post', '--bundle', dir, '--dry-run']);
  const posted = payloadOf(dir).comments[0];
  const rueckfallId = /id=([0-9a-f]{6})/.exec(posted.body)[1];

  const { env, capture } = fakeGhEnv({ threadsJson: resolvedThreadFor(posted.body) });
  const out = JSON.parse(runCli(['verify', '--bundle', dir], env));
  assert.equal(out.regressed, 1);
  assert.equal(out.resolved, 0);
  assert.equal(out.stillOpen, 0);
  assert.equal(out.posted, 2); // der Rueckfall plus Fall E, der noch keinen Thread hat
  assert.equal(out.reviewId, 4711);

  const sent = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(sent.commit_id, 'head');
  assert.equal(sent.event, 'COMMENT');
  // Der Rueckfall steht wieder am Code -- nicht in skippedExisting, obwohl seine ID
  // einem existierenden Thread gehoert. Ueber die ID geprueft, nicht ueber die Zahl:
  // eine Zahl waere auch von einem beliebigen anderen Kommentar erfuellt.
  assert.ok(
    sent.comments.some((c) => c.body.includes(`id=${rueckfallId}`)),
    'der zurueckgekehrte Befund steht nicht unter den gesetzten Kommentaren',
  );
  assert.ok(sent.comments.every((c) => c.path === 'src/A.java'));
  assert.match(sent.body, /Regression: 1 finding was/);
  assert.match(sent.body, /Discarded: 1/);
  assert.match(sent.body, /evidence not found in the bundle/);
});

test('post kennt die Analysten aus dem Bundle, nicht den heutigen Verzeichnisstand', () => {
  // fetch legt die dispatchten Analysten ins Bundle. Die Bilanz muss GENAU diese
  // kennen: ein Analyst, der seit dem fetch aus dem Plugin entfernt wurde, waere
  // sonst aus der Ausfallliste verschwunden -- und einer, der seitdem dazukam,
  // stuende als ausgefallen da, obwohl ihn niemand dispatcht hat.
  const dir = freshBundle('prr-cli-bundle-analysts-');
  const frontmatter = (name) => `---\nname: ${name}\ntitle: ${name}\nwhen: always\nseverity_max: major\n---\nBody\n`;
  mkdirSync(join(dir, 'analysts'), { recursive: true });
  for (const name of ['gate-integrity', 'spec-fidelity', 'ghost']) {
    writeFileSync(join(dir, 'analysts', `${name}.md`), frontmatter(name));
  }
  runCli(['post', '--bundle', dir, '--dry-run']);
  const body = payloadOf(dir).body;
  // ghost steht im Bundle, hat aber keine Findings-Datei -> ausgefallen.
  assert.match(body, /ghost/);
  // Die Plugin-Analysten von HEUTE sind fuer dieses Bundle ohne Bedeutung.
  assert.doesNotMatch(body, /consistency/);
});
