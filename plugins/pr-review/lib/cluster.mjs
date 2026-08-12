import { severityRank, raiseSeverity, normalizeForSearch } from './findings.mjs';
import { occurrenceIndex, findingId } from './comment.mjs';

const DEFAULT_TOLERANCE = 3;

// Trennzeichen zwischen Datei und Seite im Gruppenschluessel. Bewusst U+0000 und
// kein Leerzeichen: ein Dateipfad darf ein Leerzeichen enthalten, ein NUL-Byte
// nicht. Mit einem Leerzeichen als Trenner faellt "src/my file.java RIGHT" beim
// Zurueckzerlegen in drei Teile, und die Datei heisst danach "src/my".
// Als Escape geschrieben, nicht als rohes Byte -- ein rohes NUL im Quelltext ist
// unsichtbar und wird von Textwerkzeugen (awk, grep) am Byte abgeschnitten.
const KEY_SEP = '\u0000';

function spanOf(finding) {
  return { from: finding.start_line ?? finding.line, to: finding.line };
}

function dedupeItems(items) {
  // Zwei Analysten koennen dieselbe Aussage machen. Dann bleibt ein Eintrag
  // stehen, aber beide Tags -- die Mehrfachbetroffenheit ist das Signal.
  const seen = new Map();
  for (const item of items) {
    const key = `${normalizeForSearch(item.problem).toLowerCase()}|${normalizeForSearch(item.fix).toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function finalize(acc, file, side, haystacks, analystTitles) {
  const withTitles = acc.raw.map((f) => ({ ...f, analystTitle: analystTitles?.get(f.analyst) ?? f.analyst }));
  const analysts = [...new Set(withTitles.map((f) => f.analyst))];
  const items = dedupeItems(withTitles);

  const baseSeverity = withTitles.reduce(
    (max, f) => (severityRank(f.severity) > severityRank(max) ? f.severity : max),
    'info',
  );
  const multiple = analysts.length >= 2;
  const severity = multiple ? raiseSeverity(baseSeverity) : baseSeverity;

  // Die ID haengt am schwersten Item; bei Gleichstand am alphabetisch ersten
  // Analysten, dann am Evidenztext, dann an der Zeile. Die letzten zwei Kriterien
  // sind nicht Kosmetik: meldet EIN Analyst zwei gleich schwere Befunde in derselben
  // Zeile, sind Severity und Analystenname gleich, und ohne inhaltlichen Tiebreak
  // entscheidet die Eingabereihenfolge, welches Item die ID stellt. Dieselbe
  // Fundstelle bekaeme dann je Lauf eine andere ID -- und der Zweitlauf hielte
  // jeden Befund fuer neu, womit die ganze Idempotenz hinfaellig waere.
  const primary = [...withTitles].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.analyst.localeCompare(b.analyst) ||
      a.evidence.localeCompare(b.evidence) ||
      a.line - b.line,
  )[0];
  const haystack = haystacks?.get(file) ?? '';
  const id = findingId(file, primary.evidence, occurrenceIndex(haystack, primary.evidence, primary.line));

  return {
    file,
    side,
    start_line: acc.from === acc.to ? null : acc.from,
    line: acc.to,
    severity,
    baseSeverity,
    escalated: severity !== baseSeverity,
    tension: multiple && items.length > 1,
    analysts,
    items,
    id,
  };
}

export function clusterFindings(findings, { tolerance = DEFAULT_TOLERANCE, haystacks, analystTitles } = {}) {
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.file}${KEY_SEP}${finding.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }

  const clusters = [];
  for (const [key, group] of groups) {
    const [file, side] = key.split(KEY_SEP);
    group.sort((a, b) => spanOf(a).from - spanOf(b).from || a.line - b.line);

    let current = null;
    for (const finding of group) {
      const span = spanOf(finding);
      if (current && span.from - current.to <= tolerance) {
        current.from = Math.min(current.from, span.from);
        current.to = Math.max(current.to, span.to);
        current.raw.push(finding);
      } else {
        if (current) clusters.push(finalize(current, file, side, haystacks, analystTitles));
        current = { from: span.from, to: span.to, raw: [finding] };
      }
    }
    if (current) clusters.push(finalize(current, file, side, haystacks, analystTitles));
  }

  // side als letztes Kriterium, weil zwei Cluster in derselben Datei auf derselben
  // Zeilennummer liegen koennen -- einer auf LEFT (entfernte Zeile), einer auf
  // RIGHT. Ohne dieses Kriterium waere ihre Reihenfolge nicht durch den Vertrag
  // bestimmt, sondern durch Zufall der Gruppierung.
  clusters.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.analysts.length - a.analysts.length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.side.localeCompare(b.side),
  );
  return clusters;
}
