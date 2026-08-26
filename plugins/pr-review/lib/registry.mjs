import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { matchesGlob } from 'node:path';

// Bewusst kein YAML-Parser: sechs erlaubte Schluessel, feste Typen. Ein Tippfehler
// im Frontmatter soll laut scheitern, nicht still zu einem Default werden.
const ALLOWED = new Set(['name', 'title', 'when', 'paths', 'severity_max', 'model']);
const SEVERITIES = new Set(['info', 'minor', 'major', 'blocker']);

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('Frontmatter is missing or unterminated (--- ... ---)');
  const meta = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`Frontmatter line not readable: ${line}`);
    const [, key, valueRaw] = kv;
    if (!ALLOWED.has(key)) {
      throw new Error(`Unbekannter Frontmatter-Schluessel "${key}". Erlaubt: ${[...ALLOWED].join(', ')}`);
    }
    const value = valueRaw.trim();
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) throw new Error(`array at "${key}" is not closed on one line`);
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
        if (items.length === 0) throw new Error(`array at "${key}" has no readable element`);
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
    throw new Error(`${file}: name "${meta.name}" does not match the file name`);
  }
  if (meta.when !== 'always' && meta.when !== 'paths') {
    throw new Error(`${file}: when must be "always" or "paths", was "${meta.when}"`);
  }
  if (meta.when === 'paths' && (!Array.isArray(meta.paths) || meta.paths.length === 0)) {
    throw new Error(`${file}: when: paths needs a non-empty paths array`);
  }
  if (!SEVERITIES.has(meta.severity_max)) {
    throw new Error(`${file}: severity_max "${meta.severity_max}" is unknown`);
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

// Eine Datei ohne `---`-Kopf beansprucht nicht, Analyst zu sein. Im
// Projekt-Analystenverzeichnis liegt genau dafuer eine README mit der
// Anleitung, wie man dort Analysten anlegt -- und die wurde bisher als Analyst
// gelesen. Folge: `post` brach mit "Frontmatter fehlt" ab, nachdem alle
// Subagenten schon gelaufen waren, und die Meldung nannte die Datei nicht.
//
// Die Grenze ist bewusst eng: uebersprungen wird nur, was gar keinen Kopf hat.
// Eine Datei MIT Kopf beansprucht Analyst zu sein, und dort bleibt jeder Fehler
// laut -- auch ein unabgeschlossener Kopf. Ein Tippfehler im Frontmatter soll
// weiterhin scheitern und nicht still zu einem Default werden.
const CLAIMS_FRONTMATTER = /^---\r?\n/;

// roots in Reihenfolge steigender Prioritaet: [pluginRoot, repoRoot].
export function loadAnalysts(roots) {
  const byName = new Map();
  roots.forEach((root, index) => {
    if (!root || !existsSync(root)) return;
    const source = index === 0 ? 'plugin' : 'repo';
    for (const file of readdirSync(root).filter((f) => f.endsWith('.md')).sort()) {
      const text = readFileSync(join(root, file), 'utf8');
      if (!CLAIMS_FRONTMATTER.test(text)) continue;
      let parsed;
      try {
        parsed = parseFrontmatter(text);
      } catch (error) {
        // Ohne Dateinamen kostet die Meldung mehr Zeit als sie wert ist: die
        // Ursache liegt in einer bestimmten Datei, gemeldet wurde nur die Regel.
        throw new Error(`${file}: ${error.message}`);
      }
      const analyst = normalize(parsed.meta, file, source);
      byName.set(analyst.name, { ...analyst, body: parsed.body, file: join(root, file) });
    }
  });
  return [...byName.values()];
}

// Kontrakt und Analystendateien wandern beim fetch INS Bundle. Der Grund ist die
// Startlatenz des Dispatchs: inline bestand der Auftrag je Analyst aus Kontrakt +
// Blickrichtung, zusammen ~4000 Tokens, die das orchestrierende Modell fuer jeden
// Start einzeln als Output generieren musste — gemessen ~60 s pro Analyst. Die Starts
// lagen damit Minuten auseinander, obwohl die Subagenten selbst parallel laufen.
// Mit den Dateien im Bundle traegt der Auftrag nur noch Pfade, alle Starts liegen
// innerhalb von Sekunden — und die Invariante "Analysten lesen ausschliesslich im
// Bundle" bleibt woertlich erhalten, statt fuer Plugin-Pfade aufgeweicht zu werden.
//
// Kopiert wird die Originaldatei MIT Frontmatter: Phase 1 der SKILL liest die
// Auswahlfelder (when, paths, model) jetzt aus dem Bundle statt aus zwei
// Verzeichnissen. analysts/ wird vorher geleert — dasselbe Argument wie bei
// findings/ in bundle.mjs: der Zweitlauf holt in DASSELBE Verzeichnis, und ein
// inzwischen entfernter Analyst bliebe sonst liegen und wuerde weiter dispatcht.
export function stageAnalystMaterial({ bundleDir, contractPath, roots }) {
  if (!existsSync(contractPath)) {
    throw new Error(`analyst-contract.md not found at ${contractPath}. No dispatch without the contract.`);
  }
  const analysts = loadAnalysts(roots);
  const dir = join(bundleDir, 'analysts');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(bundleDir, 'analyst-contract.md'), readFileSync(contractPath, 'utf8'));
  for (const analyst of analysts) {
    writeFileSync(join(dir, `${analyst.name}.md`), readFileSync(analyst.file, 'utf8'));
  }
  return { analysts: analysts.map((a) => a.name).sort() };
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
