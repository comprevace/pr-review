import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { matchesGlob } from 'node:path';

// Bewusst kein YAML-Parser: sechs erlaubte Schluessel, feste Typen. Ein Tippfehler
// im Frontmatter soll laut scheitern, nicht still zu einem Default werden.
const ALLOWED = new Set(['name', 'title', 'when', 'paths', 'severity_max', 'model']);
const SEVERITIES = new Set(['info', 'minor', 'major', 'blocker']);

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('Frontmatter fehlt oder ist nicht abgeschlossen (--- ... ---)');
  const meta = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`Frontmatter-Zeile nicht lesbar: ${line}`);
    const [, key, valueRaw] = kv;
    if (!ALLOWED.has(key)) {
      throw new Error(`Unbekannter Frontmatter-Schluessel "${key}". Erlaubt: ${[...ALLOWED].join(', ')}`);
    }
    const value = valueRaw.trim();
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) throw new Error(`Array bei "${key}" nicht in einer Zeile geschlossen`);
      const inner = value.slice(1, -1).trim();
      if (inner === '') {
        meta[key] = [];
      } else if (/["']/.test(inner)) {
        // Sind Anfuehrungszeichen da, werden nur die zitierten Segmente gelesen.
        // Ein Komma INNERHALB eines Zitats gehoert zum Wert: der Brace-Glob
        // "**/*.{vue,ts}" wuerde von einem naiven split(',') zu "**/*.{vue" und
        // "ts}" zerlegt. Beide passen danach auf nichts, der Analyst wird still
        // nie gestartet -- ein Fehler, der erst auffaellt, wenn jemand sich
        // fragt, warum sein Frontend-Analyst nie laeuft.
        const items = [...inner.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]).filter((s) => s !== '');
        if (items.length === 0) throw new Error(`Array bei "${key}" hat kein lesbares Element`);
        meta[key] = items;
      } else {
        meta[key] = inner.split(',').map((s) => s.trim()).filter((s) => s !== '');
      }
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m[2] };
}

function normalize(meta, file, source) {
  for (const key of ['name', 'title', 'when', 'severity_max']) {
    if (!meta[key]) throw new Error(`${file}: Pflichtfeld "${key}" fehlt`);
  }
  if (meta.name !== basename(file, '.md')) {
    throw new Error(`${file}: name "${meta.name}" passt nicht zum Dateinamen`);
  }
  if (meta.when !== 'always' && meta.when !== 'paths') {
    throw new Error(`${file}: when muss "always" oder "paths" sein, war "${meta.when}"`);
  }
  if (meta.when === 'paths' && (!Array.isArray(meta.paths) || meta.paths.length === 0)) {
    throw new Error(`${file}: when: paths braucht ein nicht-leeres paths-Array`);
  }
  if (!SEVERITIES.has(meta.severity_max)) {
    throw new Error(`${file}: severity_max "${meta.severity_max}" unbekannt`);
  }
  return {
    name: meta.name,
    title: meta.title,
    when: meta.when,
    paths: meta.paths ?? [],
    severity_max: meta.severity_max,
    model: meta.model ?? null,
    source,
  };
}

// roots in Reihenfolge steigender Prioritaet: [pluginRoot, repoRoot].
export function loadAnalysts(roots) {
  const byName = new Map();
  roots.forEach((root, index) => {
    if (!root || !existsSync(root)) return;
    const source = index === 0 ? 'plugin' : 'repo';
    for (const file of readdirSync(root).filter((f) => f.endsWith('.md')).sort()) {
      const text = readFileSync(join(root, file), 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const analyst = normalize(meta, file, source);
      byName.set(analyst.name, { ...analyst, body, file: join(root, file) });
    }
  });
  return [...byName.values()];
}

export function selectAnalysts(analysts, changedPaths) {
  const selected = [];
  const skipped = [];
  for (const analyst of analysts) {
    if (analyst.when === 'always') {
      selected.push(analyst);
      continue;
    }
    const hit = analyst.paths.find((glob) => changedPaths.some((p) => matchesGlob(p, glob)));
    if (hit) selected.push(analyst);
    else skipped.push({ name: analyst.name, reason: `kein Pfad im Diff passt auf ${analyst.paths.join(', ')}` });
  }
  return { selected, skipped };
}
