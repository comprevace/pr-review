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

// Bewusst ohne Zeilennummer: ein Fix-Commit verschiebt Zeilen, und ein
// zeilenbasierter Schluessel wuerde jeden Befund als "neu" melden.
export function findingId(file, evidence, occurrence) {
  return createHash('sha256')
    .update(`${file} ${normalizeForSearch(evidence)} ${occurrence}`)
    .digest('hex')
    .slice(0, 6);
}

// Der Evidenz-Hash im Marker ist die zweite Haelfte der Behoben-Pruefung: beim
// Zweitlauf laesst sich ohne Zusatzspeicher feststellen, ob die zitierte Stelle
// noch im Bundle steht. Ohne ihn waere "behoben" nur eine Bedingung statt zwei.
export function evidenceHash(evidence) {
  return createHash('sha256').update(normalizeForSearch(evidence)).digest('hex').slice(0, 8);
}

export function renderMarker({ id, sev, analysts, ev }) {
  const evPart = ev ? ` ev=${ev}` : '';
  return `<!-- pr-review:v1 id=${id} sev=${sev}${evPart} analysts=${analysts.join(',')} -->`;
}

// Am Textende verankert, und das ist keine Kosmetik: renderComment setzt den Marker
// immer als letzte Zeile. Ohne Anker wuerde ein Mensch, der den Marker in einem
// Codeblock ERKLAERT, als gesetzter Marker gelesen -- und damit einen echten Befund
// unterdruecken, weil der Zweitlauf ihn fuer schon kommentiert haelt. Die
// Kommentarliste des PR ist nicht nach Autor gefiltert, also ist das kein
// Randfall, sondern der Normalfall in einem PR, in dem jemand ueber das Verfahren
// diskutiert.
const MARKER_RE = /<!--\s*pr-review:v1\s+id=([0-9a-f]{6})\s+sev=(\w+)(?:\s+ev=([0-9a-f]{8}))?\s+analysts=(\S*)\s*-->\s*$/;

export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  if (!m) return null;
  return {
    id: m[1],
    sev: m[2],
    ev: m[3] ?? null,
    analysts: m[4] === '' ? [] : m[4].split(',').filter((a) => a !== ''),
  };
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
    parts.push(`<sub>von ${cluster.baseSeverity} erhöht: zwei unabhängige Analysten</sub>`);
  }
  parts.push('');

  for (const item of cluster.items) {
    if (cluster.items.length > 1) parts.push(`**${item.analystTitle ?? item.analyst}** — ${item.title}`);
    parts.push(item.problem);
    parts.push('');
    parts.push(`> \`${item.evidence}\``);
    parts.push('');
    parts.push(`**Auftrag:** ${item.fix}`);
    parts.push('');
  }

  if (cluster.tension) {
    parts.push('<sub>⚠ Hier treffen zwei Blickrichtungen aufeinander; die Aufträge können sich widersprechen. Bitte selbst entscheiden.</sub>');
  }

  const confidence = cluster.items.some((i) => i.confidence === 'niedrig')
    ? 'niedrig'
    : cluster.items.some((i) => i.confidence === 'mittel') ? 'mittel' : 'hoch';
  parts.push(`<sub>Vertrauen: ${confidence}</sub>`);
  parts.push(renderMarker({
    id: cluster.id,
    sev: cluster.severity,
    ev: evidenceHash(cluster.items[0].evidence),
    analysts: cluster.analysts,
  }));

  return parts.join('\n');
}
