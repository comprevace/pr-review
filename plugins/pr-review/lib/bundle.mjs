import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
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

export async function buildBundle({ repo, number, ghApi, bundleDir }) {
  const dir = bundleDir ?? bundlePathFor(repo, number);
  mkdirSync(dir, { recursive: true });

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
      writeUnder(dir, join('patches', `${f.filename}.patch`), f.patch);
    }
    files.push(entry);

    if (f.status !== 'removed' && !f.patch_missing && f.patch) {
      const text = await fetchText(ghApi, repo, f.filename, headSha);
      if (text !== null) writeUnder(dir, join('files', f.filename), text);
    }

    const candidates = testCandidates(f.filename);
    if (candidates.length > 0) {
      let found = false;
      for (const cand of candidates) {
        const text = changedPaths.has(cand) ? null : await fetchText(ghApi, repo, cand, headSha);
        if (changedPaths.has(cand)) { found = true; break; }
        if (text !== null) {
          writeUnder(dir, join('tests', cand), text);
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

  const comments = await ghApi(`/repos/${repo}/pulls/${number}/comments`, { paginate: true });
  writeUnder(dir, 'previous.json', JSON.stringify(comments ?? [], null, 2));

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

  return { dir, files: files.length, changedLines, specLink: meta.spec_link, missingTests, patchMissing };
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
