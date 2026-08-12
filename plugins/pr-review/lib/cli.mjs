#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// `--skipped "name:grund,name:grund"` — die Auswahl passiert in der SKILL (Phase 1),
// die Bilanz entsteht hier. Ohne diesen Weg wuerde die Bilanz verschweigen, welche
// Analysten gar nicht gestartet sind, und ein Leser hielte das Review fuer
// vollstaendiger als es ist.
export function parseSkipped(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx < 0
        ? { name: entry, reason: 'nicht gestartet' }
        : { name: entry.slice(0, idx).trim(), reason: entry.slice(idx + 1).trim() };
    });
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

  return buildPayload(clusters, {
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
  });
}

async function cmdPost(positional, flags) {
  const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) fail('Bitte eine PR-Nummer angeben, z. B. pr-review post 55');
  const repo = flags.repo ?? (await currentRepo());
  const bundleDir = flags.bundle ?? bundlePathFor(repo, number);
  if (!existsSync(join(bundleDir, 'meta.json'))) {
    fail(`Kein Bundle unter ${bundleDir}. Erst "pr-review fetch ${number}" laufen lassen.`);
  }
  const bundle = loadBundle(bundleDir);

  const analystRoots = [
    flags['analysts-dir'] ?? join(PLUGIN_ROOT, 'analysts'),
    join(process.cwd(), '.claude', 'pr-review-analysts'),
  ];
  const analysts = loadAnalysts(analystRoots);
  const { raw, failed } = readAnalystFindings(bundleDir);
  if (raw.size === 0 && failed.length === 0) {
    fail('Keine Analysten-Findings im Bundle. Die Subagenten haben nichts nach findings/ geschrieben.');
  }
  if (raw.size === 0) {
    fail(`Alle Analysten sind ausgefallen: ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}. Kein Review gepostet.`);
  }

  const result = aggregate({
    bundle,
    analysts,
    analystFindings: raw,
    failed,
    skipped: parseSkipped(flags.skipped),
    cap: flags.cap ? Number(flags.cap) : DEFAULT_CAP,
    pluginVersionString: pluginVersion(),
  });

  const payload = { body: result.body, event: result.event, comments: result.comments };
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
  const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) fail('Bitte eine PR-Nummer angeben, z. B. pr-review verify 55');
  const repo = flags.repo ?? (await currentRepo());
  const bundleDir = flags.bundle ?? bundlePathFor(repo, number);
  if (!existsSync(join(bundleDir, 'meta.json'))) {
    fail(`Kein Bundle unter ${bundleDir}. Erst "pr-review fetch ${number}" auf dem NEUEN Stand laufen lassen.`);
  }
  const bundle = loadBundle(bundleDir);

  const analystRoots = [
    flags['analysts-dir'] ?? join(PLUGIN_ROOT, 'analysts'),
    join(process.cwd(), '.claude', 'pr-review-analysts'),
  ];
  const analysts = loadAnalysts(analystRoots);
  const { raw, failed } = readAnalystFindings(bundleDir);
  if (raw.size === 0) fail('Keine Analysten-Findings im Bundle. Kein Zweitlauf moeglich.');

  const skipped = parseSkipped(flags.skipped);
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
  // ausgeschlossen; hier kommt die Zweitlauf-Bilanz oben drauf.
  const commentable = new Map(bundle.meta.files.map((f) => [f.path, f.commentable]));
  const counts = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const cluster of delta.fresh) counts[cluster.severity]++;

  const result = buildPayload(delta.fresh, {
    commentable,
    previousIds: new Set(threads.map((t) => t.marker?.id).filter(Boolean)),
    cap: flags.cap ? Number(flags.cap) : DEFAULT_CAP,
    renderBody: (report) =>
      renderSummary({
        pluginVersion: pluginVersion(),
        analystsRun: [...raw.keys()],
        analystsSkipped: skipped,
        analystsFailed: failed,
        counts,
        rejected: [],
        anchorless: report.anchorless,
        capped: report.capped,
        skippedExisting: report.skippedExisting,
        verify: { resolved: delta.counts.resolved, stillOpen: delta.counts.stillOpen, fresh: delta.counts.fresh },
        meta: bundle.meta,
      }),
  });

  const payload = { body: result.body, event: result.event, comments: result.comments };
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
