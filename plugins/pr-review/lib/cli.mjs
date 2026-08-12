#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghApi, currentRepo, ghGraphql } from './gh.mjs';
import { buildBundle, bundlePathFor, loadBundle } from './bundle.mjs';
// Nur loadAnalysts: die Auswahl (selectAnalysts) passiert im Modell in Phase 1 der
// SKILL, weil nur dort bekannt ist, welche Analysten tatsaechlich gestartet wurden.
// Die CLI erfaehrt das Ergebnis ueber --skipped.
import { loadAnalysts } from './registry.mjs';
import { validateAll } from './findings.mjs';
import { clusterFindings } from './cluster.mjs';
import { parseMarker } from './comment.mjs';
import { buildPayload, DEFAULT_CAP } from './payload.mjs';
import { renderSummary } from './summary.mjs';
import { fetchThreads, resolveThread, computeDelta } from './threads.mjs';

const PLUGIN_ROOT = join(import.meta.dirname, '..');

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function cmdFetch(positional, flags) {
  const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) fail('Bitte eine PR-Nummer angeben, z. B. pr-review fetch 55');
  let repo = flags.repo;
  if (!repo) {
    try { repo = await currentRepo(); } catch {
      fail('Repo nicht ermittelbar. Aus einem Repo-Verzeichnis starten oder --repo owner/name angeben.');
    }
  }
  const summary = await buildBundle({ repo, number, ghApi });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function readAnalystFindings(bundleDir) {
  const dir = join(bundleDir, 'findings');
  const raw = new Map();
  const failed = [];
  if (!existsSync(dir)) return { raw, failed };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '');
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const items = Array.isArray(parsed) ? parsed : parsed?.findings;
      if (!Array.isArray(items)) throw new Error('erwartet ein Array oder {findings: []}');
      raw.set(name, items);
    } catch (err) {
      failed.push({ name, reason: `ungueltiges JSON: ${err.message}` });
    }
  }
  return { raw, failed };
}

// Gemeinsames Format fuer "--skipped" und "--failed": "name:grund,name:grund".
// Fehlt der Doppelpunkt, gilt fallbackReason -- in der Praxis gibt der Aufrufer
// aber immer einen Grund an.
function parseNamedList(value, fallbackReason) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx < 0
        ? { name: entry, reason: fallbackReason }
        : { name: entry.slice(0, idx).trim(), reason: entry.slice(idx + 1).trim() };
    });
}

// `--skipped "name:grund,name:grund"` — die Auswahl passiert in der SKILL (Phase 1),
// die Bilanz entsteht hier. Ohne diesen Weg wuerde die Bilanz verschweigen, welche
// Analysten gar nicht gestartet sind, und ein Leser hielte das Review fuer
// vollstaendiger als es ist.
export function parseSkipped(value) {
  return parseNamedList(value, 'nicht gestartet');
}

// `--failed "name:grund,name:grund"` — die CLI erkennt selbst nur kaputtes JSON in
// einer vorhandenen Datei. Ein Subagent, der abgestuerzt ist, ohne ueberhaupt eine
// Datei zu schreiben, ist fuer readAnalystFindings unsichtbar und wuerde sonst in
// der Bilanz weder unter "gelaufen" noch unter "ausgefallen" auftauchen -- das
// gepostete Review behauptete dann mehr Vollstaendigkeit als es hatte.
export function parseFailed(value) {
  return parseNamedList(value, 'ausgefallen');
}

// Die letzte Luecke im Grundsatz "nichts scheitert lautlos": --failed ist der
// deklarative Weg, aber er haengt daran, dass das orchestrierende Modell daran denkt.
// Ein Analyst, der abstuerzt, ohne eine Datei zu schreiben, ist fuer
// readAnalystFindings unsichtbar -- und wenn ihn niemand meldet, taucht er in der
// Bilanz weder unter "gelaufen" noch unter "ausgefallen" auf. Das gepostete Review
// behauptet dann mehr Vollstaendigkeit, als es hatte. Die CLI kennt alle
// Analystennamen aus loadAnalysts und kann selbst nachsehen: wer weder eine Datei
// geschrieben hat noch als nicht gestartet oder ausgefallen gemeldet ist, kommt hier in
// die Ausfallliste. Kein Abbruch -- nur benannt.
export function undeclaredAnalysts({ analysts, analystFindings, skipped, failed }) {
  const accounted = new Set([
    ...analystFindings.keys(),
    ...skipped.map((s) => s.name),
    ...failed.map((f) => f.name),
  ]);
  return analysts
    .filter((a) => !accounted.has(a.name))
    .map((a) => ({
      name: a.name,
      reason: 'keine Findings-Datei geschrieben und weder als nicht gestartet noch als ausgefallen gemeldet',
    }));
}

export function aggregate({ bundle, analysts, analystFindings, failed, skipped = [], cap, pluginVersionString }) {
  const analystMap = new Map(analysts.map((a) => [a.name, a]));
  const analystTitles = new Map(analysts.map((a) => [a.name, a.title]));

  // Die Evidenz darf im Head-Stand der Datei ODER im Patch stehen -- Befunde auf
  // entfernten Zeilen leben nur im Patch.
  const haystacks = new Map();
  for (const file of bundle.meta.files) {
    haystacks.set(
      file.path,
      `${bundle.fileText.get(file.path) ?? ''}\n${bundle.patchText.get(file.path) ?? ''}`,
    );
  }
  const knownFiles = new Set(bundle.meta.files.map((f) => f.path));

  const { accepted, rejected } = validateAll(analystFindings, { analysts: analystMap, haystacks, knownFiles });
  const clusters = clusterFindings(accepted, { haystacks, analystTitles });

  const commentable = new Map(bundle.meta.files.map((f) => [f.path, f.commentable]));
  const previousIds = new Set(
    (bundle.previous ?? []).map((c) => parseMarker(c.body)?.id).filter((id) => id !== undefined && id !== null),
  );

  const counts = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const cluster of clusters) counts[cluster.severity]++;

  // rejected wird mit zurueckgegeben, nicht nur ueber renderBody geschlossen: der
  // Zweitlauf baut seine eigene Bilanz und braucht die Liste. Ohne sie verschwand jeder
  // verworfene Befund eines Zweitlaufs samt Grund und Analystennamen.
  return {
    ...buildPayload(clusters, {
      commentable,
      previousIds,
      cap,
      renderBody: (report) =>
        renderSummary({
          pluginVersion: pluginVersionString,
          analystsRun: [...analystFindings.keys()],
          analystsSkipped: skipped,
          analystsFailed: failed,
          counts,
          rejected,
          anchorless: report.anchorless,
          capped: report.capped,
          skippedExisting: report.skippedExisting,
          verify: null,
          meta: bundle.meta,
        }),
    }),
    rejected,
  };
}

// `--bundle` liefert absichtlich keine PR-Nummer -- der in der SKILL dokumentierte
// Tuning-Modus (`--bundle <pfad> --only <analyst>`) will genau das eingefrorene
// Bundle verwenden, ohne Repo oder Nummer erneut anzugeben. Repo und Nummer stehen
// dann bereits in dessen meta.json. Ohne diese Fallunterscheidung verlangten
// cmdPost/cmdVerify immer eine Positional-Nummer und einen erreichbaren `gh` --
// und der Tuning-Modus konnte gar nicht laufen.
async function resolveTarget(positional, flags, command) {
  if (flags.bundle) {
    const metaPath = join(flags.bundle, 'meta.json');
    if (!existsSync(metaPath)) fail(`Kein Bundle unter ${flags.bundle} (meta.json fehlt).`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    // meta.repo gewinnt, denn aus diesem Repo stammt der Bundle-Inhalt. Ein
    // abweichendes --repo waere ein Versehen mit teuren Folgen: Kommentare, die aus
    // Repo A abgeleitet sind, landeten auf Repo B. Also nicht still verwerfen,
    // sondern abbrechen -- nichts in diesem Werkzeug scheitert lautlos.
    if (flags.repo && flags.repo !== meta.repo) {
      fail(`--repo ${flags.repo} widerspricht dem Bundle (${meta.repo}). Bundle-Inhalt stammt aus ${meta.repo}; lass --repo weg oder nimm das passende Bundle.`);
    }
    return { repo: meta.repo, number: meta.number, bundleDir: flags.bundle };
  }
  const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) {
    fail(`Bitte eine PR-Nummer angeben, z. B. pr-review ${command} 55, oder --bundle <pfad> ohne Nummer.`);
  }
  let repo = flags.repo;
  if (!repo) {
    try { repo = await currentRepo(); } catch {
      fail('Repo nicht ermittelbar. Aus einem Repo-Verzeichnis starten oder --repo owner/name angeben.');
    }
  }
  return { repo, number, bundleDir: bundlePathFor(repo, number) };
}

async function cmdPost(positional, flags) {
  const { repo, number, bundleDir } = await resolveTarget(positional, flags, 'post');
  if (!existsSync(join(bundleDir, 'meta.json'))) {
    fail(`Kein Bundle unter ${bundleDir}. Erst "pr-review fetch ${number}" laufen lassen.`);
  }
  const bundle = loadBundle(bundleDir);

  const analystRoots = [
    flags['analysts-dir'] ?? join(PLUGIN_ROOT, 'analysts'),
    join(process.cwd(), '.claude', 'pr-review-analysts'),
  ];
  const analysts = loadAnalysts(analystRoots);
  const { raw, failed: jsonFailed } = readAnalystFindings(bundleDir);
  const declaredFailed = [...jsonFailed, ...parseFailed(flags.failed)];
  if (raw.size === 0 && declaredFailed.length === 0) {
    fail('Keine Analysten-Findings im Bundle. Die Subagenten haben nichts nach findings/ geschrieben.');
  }
  if (raw.size === 0) {
    fail(`Alle Analysten sind ausgefallen: ${declaredFailed.map((f) => `${f.name} (${f.reason})`).join(', ')}. Kein Review gepostet.`);
  }

  const skipped = parseSkipped(flags.skipped);
  const failed = [...declaredFailed, ...undeclaredAnalysts({ analysts, analystFindings: raw, skipped, failed: declaredFailed })];

  const result = aggregate({
    bundle,
    analysts,
    analystFindings: raw,
    failed,
    skipped,
    cap: flags.cap ? Number(flags.cap) : DEFAULT_CAP,
    pluginVersionString: pluginVersion(),
  });

  // commit_id ist Pflicht, sobald zwischen fetch und post etwas gepusht wurde: die
  // Anker sind gegen den head_sha des eingefrorenen Bundles geprueft, GitHub prueft sie
  // ohne diese Angabe gegen den NEUESTEN Commit des PR und quittiert das ganze Review
  // mit 422 -- all-or-nothing, kein einziger Kommentar. Bei einem Werkzeug, dessen
  // Publikum ein Coding-Agent ist, ist ein Fix zwischen den beiden Schritten der
  // Normalfall, nicht der Randfall.
  const payload = { commit_id: bundle.meta.head_sha, body: result.body, event: result.event, comments: result.comments };
  writeFileSync(join(bundleDir, 'payload.json'), JSON.stringify(payload, null, 2));

  const stats = {
    posted: result.report.posted.length,
    anchorless: result.report.anchorless.length,
    capped: result.report.capped.length,
    skippedExisting: result.report.skippedExisting.length,
    dryRun: Boolean(flags['dry-run']),
  };

  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify({ ...stats, payloadPath: join(bundleDir, 'payload.json') }, null, 2)}\n`);
    return;
  }

  const review = await ghApi(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: payload });
  process.stdout.write(`${JSON.stringify({ ...stats, reviewId: review?.id, url: review?.html_url }, null, 2)}\n`);
}

async function cmdVerify(positional, flags) {
  const { repo, number, bundleDir } = await resolveTarget(positional, flags, 'verify');
  if (!existsSync(join(bundleDir, 'meta.json'))) {
    fail(`Kein Bundle unter ${bundleDir}. Erst "pr-review fetch ${number}" auf dem NEUEN Stand laufen lassen.`);
  }
  const bundle = loadBundle(bundleDir);

  const analystRoots = [
    flags['analysts-dir'] ?? join(PLUGIN_ROOT, 'analysts'),
    join(process.cwd(), '.claude', 'pr-review-analysts'),
  ];
  const analysts = loadAnalysts(analystRoots);
  const { raw, failed: jsonFailed } = readAnalystFindings(bundleDir);
  const declaredFailed = [...jsonFailed, ...parseFailed(flags.failed)];
  if (raw.size === 0) fail('Keine Analysten-Findings im Bundle. Kein Zweitlauf moeglich.');

  const skipped = parseSkipped(flags.skipped);
  // Im Zweitlauf ist ein unentdeckter Ausfall noch teurer als im Erstlauf: seine
  // fehlenden Meldungen erfuellen Bedingung (1) und loesen Threads auf.
  const failed = [...declaredFailed, ...undeclaredAnalysts({ analysts, analystFindings: raw, skipped, failed: declaredFailed })];
  const first = aggregate({
    bundle, analysts, analystFindings: raw, failed, skipped,
    cap: flags.cap ? Number(flags.cap) : DEFAULT_CAP,
    pluginVersionString: pluginVersion(),
  });

  const threads = await fetchThreads({ repo, number, ghGraphql });
  // Dieselbe Konstruktion wie in aggregate(): Datei UND Patch. Befunde auf entfernten
  // Zeilen leben nur im Patch -- nimmt man hier nur fileText, ist deren Zitat nie
  // auffindbar, Bedingung (2) also unbedingt erfuellt, und die ganze LEFT-Klasse
  // wuerde beim ersten Zweitlauf grundlos aufgeloest.
  const haystacks = new Map(
    bundle.meta.files.map((f) => [
      f.path,
      `${bundle.fileText.get(f.path) ?? ''}\n${bundle.patchText.get(f.path) ?? ''}`,
    ]),
  );
  // Alle vier Toepfe zaehlen als "in dieser Runde gemeldet". posted und anchorless
  // allein reichen nicht: ein Befund, der diesmal nur wegen der Kappung nicht
  // gepostet wurde oder dessen Marker schon existiert, ist deshalb nicht behoben.
  // Liesse man sie weg, griffe Bedingung (1) fuer sie nie.
  const reportedNow = [
    ...first.report.posted,
    ...first.report.anchorless,
    ...first.report.capped,
    ...first.report.skippedExisting,
  ];
  const delta = computeDelta({ clusters: reportedNow, threads, haystacks });

  // Nur das Delta posten. Bereits gesetzte IDs sind ueber previous.json ohnehin
  // ausgeschlossen; hier kommt die Zweitlauf-Bilanz oben drauf. Rueckfaelle gehoeren
  // mit ins Delta: sie sind gemeldet, ihr Thread ist aber aufgeloest, und ohne sie
  // waeren sie nirgends sichtbar.
  const commentable = new Map(bundle.meta.files.map((f) => [f.path, f.commentable]));
  const toPost = [...delta.fresh, ...delta.regressed];
  const counts = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const cluster of toPost) counts[cluster.severity]++;

  // Ein Rueckfall traegt zwangslaeufig die ID eines existierenden -- aufgeloesten --
  // Threads. Bliebe sie in previousIds, landete er in skippedExisting und waere genau
  // dort still, wo er am lautesten sein muesste.
  const regressedIds = new Set(delta.regressed.map((c) => c.id));
  const result = buildPayload(toPost, {
    commentable,
    previousIds: new Set(
      threads.map((t) => t.marker?.id).filter((id) => Boolean(id) && !regressedIds.has(id)),
    ),
    cap: flags.cap ? Number(flags.cap) : DEFAULT_CAP,
    renderBody: (report) =>
      renderSummary({
        pluginVersion: pluginVersion(),
        analystsRun: [...raw.keys()],
        analystsSkipped: skipped,
        analystsFailed: failed,
        counts,
        rejected: first.rejected,
        anchorless: report.anchorless,
        capped: report.capped,
        skippedExisting: report.skippedExisting,
        verify: {
          resolved: delta.counts.resolved,
          stillOpen: delta.counts.stillOpen,
          fresh: delta.counts.fresh,
          regressed: delta.counts.regressed,
        },
        meta: bundle.meta,
      }),
  });

  // Auch hier commit_id: der Zweitlauf laeuft per Definition auf einem PR, an dem
  // gerade gearbeitet wird -- die Wahrscheinlichkeit eines Pushs zwischen fetch und
  // verify ist hier hoeher als beim Erstlauf, nicht niedriger.
  const payload = { commit_id: bundle.meta.head_sha, body: result.body, event: result.event, comments: result.comments };
  writeFileSync(join(bundleDir, 'payload.json'), JSON.stringify(payload, null, 2));

  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify({ ...delta.counts, dryRun: true, wouldPost: result.comments.length }, null, 2)}\n`);
    return;
  }

  for (const threadId of delta.resolvable) {
    await resolveThread({ threadId, ghGraphql });
  }
  const review = await ghApi(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: payload });
  process.stdout.write(`${JSON.stringify({ ...delta.counts, posted: result.comments.length, reviewId: review?.id }, null, 2)}\n`);
}

// realpathSync ist hier zwingend: Node loest import.meta.url fuer das Hauptmodul
// ueber den echten Pfad auf, process.argv[1] aber nicht. Liegt das Plugin unter einem
// Symlink -- der Normalfall bei einer Plugin-Installation --, weichen die beiden URLs
// ab, isEntryPoint wird false, und die CLI tut still gar nichts: keine Ausgabe,
// Exit 0. Das ist schlimmer als der Fehler, den dieser Guard behebt.
const isEntryPoint =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntryPoint) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  try {
    if (command === 'fetch') await cmdFetch(positional, flags);
    else if (command === 'path') {
      const repo = flags.repo ?? (await currentRepo());
      process.stdout.write(`${bundlePathFor(repo, Number(positional[0]))}\n`);
    }
    else if (command === 'post') await cmdPost(positional, flags);
    else if (command === 'verify') await cmdVerify(positional, flags);
    else {
      fail('Unbekanntes Kommando. Verfuegbar: fetch, post, verify, path');
    }
  } catch (err) {
    fail(err.message);
  }
}
