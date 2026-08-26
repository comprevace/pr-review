import { createHash } from 'node:crypto';
import { normalizeForSearch } from './findings.mjs';

export const SEVERITY_ICON = { blocker: '🔴', major: '🟠', minor: '🟡', info: '⚪' };

// Welches Vorkommen der Evidenz ist gemeint? Das der Fundzeile am naechsten.
// Bei Gleichstand das erste -- deterministisch, damit die ID reproduzierbar bleibt.
export function occurrenceIndex(haystack, evidence, line) {
  const needle = normalizeForSearch(evidence);
  if (needle === '') return 0;
  const lines = String(haystack).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalizeForSearch(lines[i]).includes(needle)) hits.push(i + 1);
  }
  if (hits.length === 0) return 0;
  let best = 0;
  let bestDistance = Infinity;
  for (let k = 0; k < hits.length; k++) {
    const distance = Math.abs(hits[k] - line);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = k;
    }
  }
  return best + 1;
}

const SIDES = new Set(['LEFT', 'RIGHT']);

// Trennzeichen im Hash-Input. Bewusst U+0000 und kein Leerzeichen: ein Dateipfad darf
// ein Leerzeichen enthalten, ein NUL-Byte nicht. Mit einem Leerzeichen ergaeben
// ("src/my file", "x") und ("src/my", "file x") denselben Schluessel -- zwei
// verschiedene Befunde teilten sich eine ID. Dieselbe Ueberlegung wie bei KEY_SEP in
// cluster.mjs, als Escape geschrieben, weil ein rohes NUL im Quelltext unsichtbar ist.
const ID_SEP = '\u0000';

// Bewusst ohne Zeilennummer: ein Fix-Commit verschiebt Zeilen, und ein
// zeilenbasierter Schluessel wuerde jeden Befund als "neu" melden.
//
// Die Seite gehoert dagegen in den Schluessel. Beim Verschieben von Code steht dasselbe
// Fragment einmal als entfernte und einmal als hinzugefuegte Zeile im Diff; die Cluster
// sind bereits nach Seite getrennt, ihre IDs waren es nicht. Zwei Threads teilten sich
// dann eine ID, und der Zweitlauf beantwortet Bedingung (1) fuer den einen mit der
// Meldung des anderen -- ausserdem ueberschreibt clusterById den einen Cluster mit dem
// anderen, womit ein Rueckfall den falschen Befund postet.
//
// Kein Standardwert fuer side: ein Aufrufer, der sie vergisst, wuerde still genau die
// Kollision wiederherstellen, die dieser Schluessel beseitigt.
export function findingId(file, evidence, occurrence, side) {
  if (!SIDES.has(side)) throw new Error(`findingId braucht side LEFT oder RIGHT, war "${side}"`);
  return createHash('sha256')
    .update([file, normalizeForSearch(evidence), occurrence, side].join(ID_SEP))
    .digest('hex')
    .slice(0, 6);
}

// Der Evidenz-Hash im Marker ist die zweite Haelfte der Behoben-Pruefung: beim
// Zweitlauf laesst sich ohne Zusatzspeicher feststellen, ob die zitierte Stelle
// noch im Bundle steht. Ohne ihn waere "behoben" nur eine Bedingung statt zwei.
export function evidenceHash(evidence) {
  return createHash('sha256').update(normalizeForSearch(evidence)).digest('hex').slice(0, 8);
}

// v2, weil die ID seit dieser Version die Seite enthaelt. Die Version im Marker ist an
// das ID-Schema gebunden: ohne den Wechsel waeren zwei unvereinbare Schemata unter
// demselben Namen unterwegs, und einem Kommentar waere nicht anzusehen, nach welcher
// Regel seine ID entstanden ist.
export const MARKER_VERSION = 'v2';

export function renderMarker({ id, sev, analysts, ev }) {
  const evPart = ev ? ` ev=${ev}` : '';
  return `<!-- pr-review:${MARKER_VERSION} id=${id} sev=${sev}${evPart} analysts=${analysts.join(',')} -->`;
}

// Am Textende verankert, und das ist keine Kosmetik: renderComment setzt den Marker
// immer als letzte Zeile. Ohne Anker wuerde ein Mensch, der den Marker in einem
// Codeblock ERKLAERT, als gesetzter Marker gelesen -- und damit einen echten Befund
// unterdruecken, weil der Zweitlauf ihn fuer schon kommentiert haelt. Die
// Kommentarliste des PR ist nicht nach Autor gefiltert, also ist das kein
// Randfall, sondern der Normalfall in einem PR, in dem jemand ueber das Verfahren
// diskutiert.
//
// Gelesen werden v1 UND v2. Ein v1-Marker nicht mehr zu erkennen hiesse, seinen Thread
// in die Klasse "fremder Kommentar" zu schieben -- der wird nie angetastet und haengt
// dann fuer immer offen, auch wenn der Befund laengst behoben ist. Gelesen bleibt er
// ueber sein Zitat aufloesbar; nur seine ID passt nach der Rotation zu keinem Cluster
// mehr. Der Preis der Rotation ist damit ein Duplikat, nie ein falsches "behoben".
const MARKER_RE = /<!--\s*pr-review:(v[12])\s+id=([0-9a-f]{6})\s+sev=(\w+)(?:\s+ev=([0-9a-f]{8}))?\s+analysts=(\S*)\s*-->\s*$/;

export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  if (!m) return null;
  return {
    // version wird mitgegeben, weil sie sagt, nach welcher Regel die ID entstanden ist.
    // Der Zweitlauf braucht das: eine ID aus einem alten Schema kann in den Meldungen
    // dieses Laufs gar nicht mehr vorkommen, und wer das nicht weiss, haelt Bedingung
    // (1) irrtuemlich fuer erfuellt.
    version: m[1],
    id: m[2],
    sev: m[3],
    ev: m[4] ?? null,
    analysts: m[5] === '' ? [] : m[5].split(',').filter((a) => a !== ''),
  };
}

// Das Zitat, das renderComment als erstes Blockquote ausgibt. Der Zweitlauf braucht
// den TEXT, nicht nur den Hash: die Frage lautet "steht dieses Zitat noch woertlich
// irgendwo in der Datei", und ein Hash laesst sich nicht auf Teilstring pruefen.
const EVIDENCE_RE = /^> `(.*)`\s*$/m;

export function parseEvidence(body) {
  const m = EVIDENCE_RE.exec(String(body ?? ''));
  return m ? m[1] : null;
}

export function renderComment(cluster) {
  const icon = SEVERITY_ICON[cluster.severity] ?? '⚪';
  const tags = cluster.items
    .map((i) => i.analystTitle ?? i.analyst)
    .filter((t, idx, arr) => arr.indexOf(t) === idx)
    .map((t) => `\`${t}\``)
    .join(' + ');

  const parts = [`**${icon} ${cluster.severity}** · ${tags}`];
  if (cluster.escalated) {
    parts.push(`<sub>raised from ${cluster.baseSeverity}: two independent analysts</sub>`);
  }
  parts.push('');

  for (const item of cluster.items) {
    if (cluster.items.length > 1) parts.push(`**${item.analystTitle ?? item.analyst}** — ${item.title}`);
    parts.push(item.problem);
    parts.push('');
    parts.push(`> \`${item.evidence}\``);
    parts.push('');
    parts.push(`**Action:** ${item.fix}`);
    parts.push('');
  }

  if (cluster.tension) {
    parts.push('<sub>⚠ Two review perspectives meet here; their actions may contradict each other. Decide for yourself.</sub>');
  }

  const confidence = cluster.items.some((i) => i.confidence === 'low')
    ? 'low'
    : cluster.items.some((i) => i.confidence === 'medium') ? 'medium' : 'high';
  parts.push(`<sub>Confidence: ${confidence}</sub>`);
  parts.push(renderMarker({
    id: cluster.id,
    sev: cluster.severity,
    ev: evidenceHash(cluster.items[0].evidence),
    analysts: cluster.analysts,
  }));

  return parts.join('\n');
}
