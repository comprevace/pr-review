import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { commentableRanges } from './diff.mjs';

// Der Files-Endpunkt deckelt bei 3000 Dateien. Ein stillschweigend
// unvollstaendiges Bundle erzeugt ein stillschweigend unvollstaendiges Review.
const MAX_FILES = 3000;

// NICHT unter ~/.claude: Claude Code behandelt das eigene Konfigurationsverzeichnis als
// geschuetzten Pfad und verweigert Agenten jeden Schreibzugriff darauf. Die Analysten
// koennten ihre findings/*.json dort nie ablegen -- jeder Lauf endete mit "alle
// Analysten ausgefallen". Live aufgefallen, nicht hergeleitet.
export function bundlePathFor(repo, number) {
  const [owner, name] = repo.split('/');
  return join(homedir(), '.cache', 'pr-review', `${owner}__${name}__${number}`);
}

const TEST_SUFFIX_RE = /(Test|Tests|IT)\.java$|\.(spec|test)\.(ts|tsx|js|mjs)$/;

export function testCandidates(path) {
  if (TEST_SUFFIX_RE.test(path)) return [];
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  if (ext === '.java') {
    // Ohne "src/main/java"-Segment (z. B. eine Datei direkt unter "src/") bleibt
    // testDir gleich dir; die Kandidaten liegen dann im selben Verzeichnis.
    const testDir = dir.replace('/src/main/java/', '/src/test/java/').replace(/^src\/main\/java\//, 'src/test/java/');
    return [`${testDir}/${stem}Test.java`, `${testDir}/${stem}Tests.java`, `${testDir}/${stem}IT.java`];
  }
  if (['.vue', '.ts', '.tsx', '.js', '.mjs'].includes(ext)) {
    return [
      `${dir}/${stem}.spec.ts`,
      `${dir}/${stem}.test.ts`,
      `${dir}/__tests__/${stem}.spec.ts`,
      `${dir}/__tests__/${stem}.test.ts`,
    ];
  }
  return [];
}

export function resolveSpecPath({ body = '', title = '', headRef = '' }) {
  const direct = /specs\/([A-Z][A-Z0-9]*-\d+)\.md/.exec(body || '');
  if (direct) return `specs/${direct[1]}.md`;
  const fromTitle = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(title || '');
  if (fromTitle) return `specs/${fromTitle[1]}.md`;
  const fromBranch = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(headRef || '');
  if (fromBranch) return `specs/${fromBranch[1]}.md`;
  return null;
}

function writeUnder(dir, relPath, content) {
  const target = join(dir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// Die drei Verzeichnisse, die je Lauf komplett neu entstehen. Sie sammeln sich sonst
// ueber Runden hinweg an, denn geschrieben wird nur, was diesmal geholt wurde -- eine
// Datei, die in Runde 2 geloescht wurde, ihren Patch verloren hat oder deren Test
// verschwunden ist, behielte ihren Stand aus Runde 1. Fuer files/ und patches/ ist das
// nicht bloss Muell: beide bilden den Haystack, gegen den Bedingung (2) prueft. Ein
// veralteter Stand haelt jedes Zitat auffindbar, und ein wirklich behobener Befund
// loest nie auf. tests/ liegt nicht im Haystack, wird aber von den Analysten gelesen.
const STAGED_DIRS = ['files', 'patches', 'tests', 'siblings', 'manifests'];

// Die Abhaengigkeitsmanifeste im Wurzelverzeichnis. Ein Stack-Analyst empfiehlt
// Framework-Mittel -- und ob das jeweilige Mittel ueberhaupt auf dem Classpath liegt,
// steht genau hier. Ohne sie raet er: "@Cacheable statt eigener Map" ist falsch, wenn
// kein Cache-Starter eingebunden ist, und ein Analyst, der raet, wird nicht gelesen.
//
// Bewusst nur die Wurzel: in einem mehrmodularen Projekt kann das Modul-Manifest fehlen.
// Das ist eine bekannte Luecke, kein Versehen -- der Analystenkontrakt sagt ausdruecklich,
// dass daraus ein Vorbehalt im Befund werden muss statt einer Annahme.
const MANIFEST_CANDIDATES = ['build.gradle.kts', 'build.gradle', 'pom.xml', 'package.json'];

// Geschwister: Dateien im selben Verzeichnis wie eine geaenderte Datei. Sie existieren
// fuer genau einen Analysten (consistency) -- ein Agent, der Story 7 baut, kennt Stories
// 1-6 nicht, und ob es fuer dasselbe Problem schon ein Muster gibt, ist aus dem Diff
// allein nicht zu sehen.
//
// Drei Begrenzungen, jede aus einem eigenen Grund:
//   - nur gleiche Endung: eine .md neben einer .java sagt nichts ueber Codemuster und
//     kostet nur Kontext
//   - Deckel je Verzeichnis: ein Verzeichnis mit 200 Dateien wuerde das Bundle und die
//     Kosten sprengen; E2 des Designs will die Kosten an der Diffgroesse halten
//   - Groessendeckel je Datei: eine generierte Riesendatei traegt kein Muster bei
// Was der Deckel abschneidet, wird in meta.json benannt. Wer nicht weiss, dass die
// Nachbarschaft gekappt wurde, haelt "kein Musterbruch gefunden" fuer eine Aussage
// ueber das Verzeichnis.
const MAX_SIBLINGS_PER_DIR = 8;
const MAX_SIBLING_BYTES = 100_000;

// Gestaged wird INNERHALB des Bundle-Verzeichnisses, damit das Umschalten ein rename
// auf demselben Dateisystem bleibt und nicht ueber Verzeichnisse hinweg kopiert.
const STAGING = '.incoming';

// Umgeschaltet wird erst, wenn alles Holen durch ist. Vorher zu leeren hiesse: ein
// abgebrochenes fetch laesst ein halb ausgeraeumtes Bundle zurueck, und das ist
// schlimmer als ein veraltetes -- es sieht vollstaendig aus und ist es nicht.
function commitStaged(dir) {
  for (const name of STAGED_DIRS) {
    const staged = join(dir, STAGING, name);
    rmSync(join(dir, name), { recursive: true, force: true });
    // Nicht angelegt heisst diesmal leer -- etwa wenn jede Datei binaer war. Das
    // Verzeichnis bleibt dann weg, statt den Stand des Vorlaufs zu behalten.
    if (existsSync(staged)) renameSync(staged, join(dir, name));
  }
  rmSync(join(dir, STAGING), { recursive: true, force: true });
}

async function fetchText(ghApi, repo, path, ref) {
  try {
    const res = await ghApi(`/repos/${repo}/contents/${encodeURI(path)}?ref=${ref}`);
    if (res?.encoding !== 'base64' || typeof res.content !== 'string') return null;
    return Buffer.from(res.content, 'base64').toString('utf8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Der Verzeichnis-Endpunkt liefert ein Array, der Datei-Endpunkt ein Objekt mit content.
// Deshalb nicht ueber fetchText: das wuerde ein Listing stillschweigend als "nicht
// gefunden" behandeln, und die ganze Nachbarschaft bliebe unbemerkt leer.
async function fetchDirListing(ghApi, repo, dir, ref) {
  const path = dir === '.' || dir === '' ? '' : `/${encodeURI(dir)}`;
  try {
    const res = await ghApi(`/repos/${repo}/contents${path}?ref=${ref}`);
    return Array.isArray(res) ? res : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

// Nachbarschaft der geaenderten Dateien einsammeln. Geloeschte Dateien bringen keine
// Nachbarschaft ein: ihr Verzeichnis interessiert nur, wenn dort noch etwas steht, und
// das kommt ueber die anderen geaenderten Dateien mit.
async function collectSiblings({ ghApi, repo, headSha, staging, files, changedPaths }) {
  const collected = [];
  const truncated = [];
  const dirs = [...new Set(
    files.filter((f) => f.status !== 'removed').map((f) => dirname(f.path)),
  )].sort();

  for (const dir of dirs) {
    // Nur Endungen, die in diesem Verzeichnis auch wirklich geaendert wurden. Sonst
    // holte ein geaendertes .java in einem gemischten Verzeichnis auch die .ts-Nachbarn
    // mit, und consistency verglichen Muster ueber Sprachgrenzen hinweg.
    const extsInDir = new Set(
      files.filter((f) => f.status !== 'removed' && dirname(f.path) === dir)
        .map((f) => extname(f.path))
        .filter((e) => e !== ''),
    );
    if (extsInDir.size === 0) continue;

    const entries = await fetchDirListing(ghApi, repo, dir, headSha);
    const wanted = entries.filter((e) => e.type === 'file'
      && !changedPaths.has(e.path)
      && extsInDir.has(extname(e.name))
      && (e.size ?? 0) <= MAX_SIBLING_BYTES);

    if (wanted.length > MAX_SIBLINGS_PER_DIR) truncated.push(dir);
    for (const entry of wanted.slice(0, MAX_SIBLINGS_PER_DIR)) {
      const text = await fetchText(ghApi, repo, entry.path, headSha);
      if (text === null) continue;
      writeUnder(staging, join('siblings', entry.path), text);
      collected.push(entry.path);
    }
  }
  return { collected, truncated };
}

export async function buildBundle({ repo, number, ghApi, bundleDir }) {
  const dir = bundleDir ?? bundlePathFor(repo, number);
  mkdirSync(dir, { recursive: true });
  // Reste eines abgebrochenen Vorlaufs zuerst weg: sonst mischt sich dessen halber
  // Stand in das, was diesmal geholt wird.
  const staging = join(dir, STAGING);
  rmSync(staging, { recursive: true, force: true });

  try {
    return await fetchInto({ repo, number, ghApi, dir, staging });
  } finally {
    // Nach dem Umschalten ist staging bereits weg; nach einem Abbruch liegt hier ein
    // Teilstand, den niemand lesen soll -- am wenigsten ein Analyst, der das
    // Bundle-Verzeichnis durchsucht.
    rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchInto({ repo, number, ghApi, dir, staging }) {
  const pr = await ghApi(`/repos/${repo}/pulls/${number}`);
  const rawFiles = await ghApi(`/repos/${repo}/pulls/${number}/files`, { paginate: true });
  if (rawFiles.length === 0) {
    throw new Error(`PR ${number} hat keine geaenderten Dateien. Kein Review moeglich.`);
  }
  if (rawFiles.length >= MAX_FILES) {
    throw new Error(
      `PR ${number} hat ${rawFiles.length} Dateien; der Files-Endpunkt deckelt bei ${MAX_FILES}. ` +
        'Abbruch, weil ein unvollstaendiges Bundle ein unvollstaendiges Review erzeugen wuerde.',
    );
  }
  const headSha = pr.head.sha;

  const files = [];
  const patchMissing = [];
  const missingTests = [];
  const patchParts = [];
  let changedLines = 0;
  // Einmal aufbauen, nicht je Datei. "removed" wird ausgeschlossen: eine im PR
  // geloeschte Testdatei existiert am head_sha nicht mehr und darf nicht als
  // "Test vorhanden" zaehlen -- sonst verschwindet die Produktivdatei still aus
  // missing_tests, obwohl ihr Test gerade weggefallen ist.
  const changedPaths = new Set(rawFiles.filter((x) => x.status !== 'removed').map((x) => x.filename));

  for (const f of rawFiles) {
    const entry = {
      path: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      commentable: commentableRanges(f.patch ?? null),
    };
    changedLines += entry.additions + entry.deletions;
    if (!f.patch) {
      entry.patch_missing = true;
      patchMissing.push(f.filename);
    } else {
      patchParts.push(`--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`);
      writeUnder(staging, join('patches', `${f.filename}.patch`), f.patch);
    }
    files.push(entry);

    if (f.status !== 'removed' && !f.patch_missing && f.patch) {
      const text = await fetchText(ghApi, repo, f.filename, headSha);
      if (text !== null) writeUnder(staging, join('files', f.filename), text);
    }

    const candidates = testCandidates(f.filename);
    if (candidates.length > 0) {
      let found = false;
      for (const cand of candidates) {
        const text = changedPaths.has(cand) ? null : await fetchText(ghApi, repo, cand, headSha);
        if (changedPaths.has(cand)) { found = true; break; }
        if (text !== null) {
          writeUnder(staging, join('tests', cand), text);
          found = true;
          break;
        }
      }
      if (!found) missingTests.push(f.filename);
    }
  }

  const specLink = resolveSpecPath({ body: pr.body, title: pr.title, headRef: pr.head.ref });
  const specText = specLink ? await fetchText(ghApi, repo, specLink, headSha) : null;
  writeUnder(dir, 'spec.md', specText ?? '');
  const conventions = await fetchText(ghApi, repo, 'CLAUDE.md', headSha);
  writeUnder(dir, 'conventions.md', conventions ?? '');

  const siblings = await collectSiblings({ ghApi, repo, headSha, staging, files, changedPaths });

  const manifests = [];
  for (const name of MANIFEST_CANDIDATES) {
    const text = await fetchText(ghApi, repo, name, headSha);
    if (text === null) continue;
    writeUnder(staging, join('manifests', name), text);
    manifests.push(name);
  }

  const comments = await ghApi(`/repos/${repo}/pulls/${number}/comments`, { paginate: true });
  writeUnder(dir, 'previous.json', JSON.stringify(comments ?? [], null, 2));

  // Ab hier wird nichts mehr geholt: jetzt ist der frisch geholte Stand vollstaendig
  // und darf den alten ersetzen. Direkt davor steht die letzte Netzoperation, direkt
  // danach nur noch das Schreiben von meta.json und diff.patch, die denselben Stand
  // beschreiben.
  commitStaged(dir);

  const meta = {
    repo,
    number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    author: pr.user?.login ?? '',
    labels: (pr.labels ?? []).map((l) => l.name),
    base_sha: pr.base.sha,
    head_sha: headSha,
    head_ref: pr.head.ref,
    spec_link: specLink,
    spec_missing: specText === null,
    conventions_missing: conventions === null,
    missing_tests: missingTests,
    // Bewusst NEBEN files, nicht darin. files ist die Liste der geaenderten Dateien und
    // speist knownFiles und die Haystacks der Evidenzpruefung. Ein Geschwister dort
    // einzutragen wuerde Zitate aus UNVERAENDERTEN Dateien gueltig machen und die
    // Evidenzpflicht fuer jeden Analysten aufweichen, nicht nur fuer consistency.
    siblings: siblings.collected,
    siblings_truncated: siblings.truncated,
    // Ebenfalls neben files, aus demselben Grund: unveraendert, also nicht zitierbar.
    manifests,
    files,
  };
  writeUnder(dir, 'meta.json', JSON.stringify(meta, null, 2));
  writeUnder(dir, 'diff.patch', patchParts.join('\n'));
  // findings/ leeren, nicht nur anlegen: der Zweitlauf holt in DASSELBE
  // Bundle-Verzeichnis, und sonst ueberlebt hier die JSON-Datei des ersten Laufs. Ein
  // Analyst, der diesmal abgestuerzt ist, erschiene mit ihr in der Bilanz als
  // "gelaufen", und seine veralteten Befunde erfuellten Bedingung (1) -- der Thread
  // bliebe offen, obwohl der Befund behoben ist. Genau die Umkehrung der Absicht: der
  // Ausfall waere unsichtbar UND wirksam. Erst nach dem erfolgreichen Holen, damit ein
  // abgebrochenes fetch das alte, in sich stimmige Bundle nicht halb ausraeumt.
  rmSync(join(dir, 'findings'), { recursive: true, force: true });
  mkdirSync(join(dir, 'findings'), { recursive: true });

  return {
    dir, files: files.length, changedLines, specLink: meta.spec_link, missingTests, patchMissing,
    siblings: siblings.collected.length,
    siblingsTruncated: siblings.truncated,
    manifests,
  };
}

function walk(root, prefix = '') {
  const out = [];
  const base = join(root, prefix);
  if (!existsSync(base)) return out;
  for (const name of readdirSync(base)) {
    const rel = prefix ? join(prefix, name) : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export function loadBundle(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const fileText = new Map();
  for (const rel of walk(join(dir, 'files'))) {
    fileText.set(rel, readFileSync(join(dir, 'files', rel), 'utf8'));
  }
  const patchText = new Map();
  for (const rel of walk(join(dir, 'patches'))) {
    patchText.set(rel.replace(/\.patch$/, ''), readFileSync(join(dir, 'patches', rel), 'utf8'));
  }
  const previousPath = join(dir, 'previous.json');
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : [];
  return { meta, dir, fileText, patchText, previous };
}
