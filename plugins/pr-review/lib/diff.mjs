// Parst die `patch`-Felder aus GET /repos/{o}/{r}/pulls/{n}/files zu einer Map
// kommentierbarer Zeilen. GitHub erlaubt Review-Kommentare nur auf Zeilen, die im
// Diff vorkommen: Kontext- und hinzugefuegte Zeilen auf RIGHT, Kontext- und
// entfernte Zeilen auf LEFT. Ein Kommentar ausserhalb quittiert die API mit 422 --
// und zwar fuer das gesamte Review, nicht nur fuer diesen einen Kommentar.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch) {
  const hunks = [];
  if (!patch) return hunks;
  let hunk = null;
  for (const line of String(patch).split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // "\ No newline at end of file" ist ein Kommentar des Diff-Formats und
    // gehoert zu keiner Seite -- mitzaehlen wuerde alle Folgezeilen verschieben.
    if (line.startsWith('\\')) continue;
    const kind = line[0];
    if (kind === ' ' || kind === '+' || kind === '-') hunk.lines.push(line);
    // Ein leerer String entsteht durch das abschliessende \n des Patches und ist
    // keine Diff-Zeile. Echte Leerzeilen im Kontext kommen als " " an.
  }
  return hunks;
}

export function toRanges(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export function commentableRanges(patch) {
  const right = [];
  const left = [];
  for (const hunk of parseHunks(patch)) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const kind = line[0];
      if (kind === ' ') {
        right.push(newLine++);
        left.push(oldLine++);
      } else if (kind === '+') {
        right.push(newLine++);
      } else if (kind === '-') {
        left.push(oldLine++);
      }
    }
  }
  return { RIGHT: toRanges(right), LEFT: toRanges(left) };
}

export function isCommentable(map, side, line) {
  const ranges = map?.[side];
  if (!Array.isArray(ranges)) return false;
  return ranges.some(([from, to]) => line >= from && line <= to);
}
