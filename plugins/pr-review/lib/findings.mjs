export const SEVERITIES = ['info', 'minor', 'major', 'blocker'];
export const CONFIDENCES = ['hoch', 'mittel', 'niedrig'];
const MAX_EVIDENCE = 200;

export function severityRank(s) {
  const i = SEVERITIES.indexOf(s);
  if (i < 0) throw new Error(`Unbekannte Severity: ${s}`);
  return i;
}

export function clampSeverity(s, max) {
  return severityRank(s) > severityRank(max) ? max : s;
}

export function raiseSeverity(s) {
  // info wird bewusst nicht eskaliert: eine Beobachtung bleibt eine Beobachtung.
  if (s === 'info') return 'info';
  return SEVERITIES[Math.min(severityRank(s) + 1, SEVERITIES.length - 1)];
}

export function normalizeForSearch(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function reject(reason) {
  return { ok: false, reason };
}

export function validateFinding(raw, ctx) {
  const analyst = ctx.analysts.get(raw.analyst);
  if (!analyst) return reject(`unbekannter Analyst "${raw.analyst}"`);

  for (const key of ['file', 'title', 'problem', 'evidence', 'fix']) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') return reject(`Pflichtfeld "${key}" fehlt oder leer`);
  }
  if (!ctx.knownFiles.has(raw.file)) return reject(`Datei "${raw.file}" ist nicht im Diff`);
  if (!Number.isInteger(raw.line) || raw.line < 1) return reject('Feld "line" muss eine positive Ganzzahl sein');

  const side = raw.side ?? 'RIGHT';
  if (side !== 'RIGHT' && side !== 'LEFT') return reject(`Feld "side" muss RIGHT oder LEFT sein, war "${side}"`);

  let startLine = null;
  if (raw.start_line !== undefined && raw.start_line !== null) {
    if (!Number.isInteger(raw.start_line) || raw.start_line < 1) return reject('Feld "start_line" muss eine positive Ganzzahl sein');
    if (raw.start_line > raw.line) return reject('start_line liegt hinter line');
    startLine = raw.start_line === raw.line ? null : raw.start_line;
  }

  if (!SEVERITIES.includes(raw.severity)) return reject(`unbekannte Severity "${raw.severity}"`);
  const confidence = raw.confidence ?? 'mittel';
  if (!CONFIDENCES.includes(confidence)) return reject(`unbekanntes Vertrauen "${confidence}"`);

  if (/\r?\n/.test(raw.evidence)) return reject('Evidenz muss einzeilig sein');
  if (raw.evidence.length > MAX_EVIDENCE) return reject(`Evidenz laenger als ${MAX_EVIDENCE} Zeichen`);

  // Zeilenweise suchen, nicht im normalisierten Gesamttext. Kollabiert man den
  // ganzen Haystack auf eine Zeile, kann eine einzeilige Evidenz ueber eine
  // Zeilengrenze hinweg "gefunden" werden: aus dem Ende von Zeile N und dem Anfang
  // von Zeile N+1 wird stillschweigend ein Treffer, und "woertlich im Bundle"
  // bedeutet dann nur noch "woertlich, nachdem wir die Zeilengrenzen weggeworfen
  // haben". Das ist ausserdem genau die Suche, die Task 6 fuer occurrenceIndex
  // verwendet -- beide muessen uebereinstimmen, sonst validiert der eine einen
  // Befund, den der andere nicht wiederfindet.
  const needle = normalizeForSearch(raw.evidence);
  const haystack = String(ctx.haystacks.get(raw.file) ?? '');
  const evidenceFound = haystack.split('\n').some((line) => normalizeForSearch(line).includes(needle));
  if (!evidenceFound) return reject('Evidenz im Bundle nicht auffindbar');

  const severity = clampSeverity(raw.severity, analyst.severity_max);
  // Geprueft wird die GEMELDETE Severity, nicht die gedeckelte. Sonst haengt die
  // Vertrauensregel am severity_max des Analysten: bei "severity_max: minor" -- eine
  // legitime repo-lokale Entscheidung -- landet jede Meldung auf minor, und "niedrig"
  // waere fuer diesen Analysten auf JEDER Stufe unbenutzbar, auch wenn er einen
  // schwerwiegenden Verdacht gemeldet hat. Der Deckel begrenzt, wie laut ein Befund
  // sein darf; er soll nicht entscheiden, ob er ueberhaupt zaehlt.
  if (confidence === 'niedrig' && severityRank(raw.severity) <= severityRank('minor')) {
    return reject('niedriges Vertrauen bei geringer Severity');
  }

  return {
    ok: true,
    finding: {
      analyst: analyst.name,
      file: raw.file,
      line: raw.line,
      start_line: startLine,
      side,
      severity,
      baseSeverity: severity,
      title: raw.title.trim(),
      problem: raw.problem.trim(),
      evidence: raw.evidence,
      fix: raw.fix.trim(),
      confidence,
    },
  };
}

export function validateAll(rawByAnalyst, ctx) {
  const accepted = [];
  const rejected = [];
  for (const [analystName, items] of rawByAnalyst) {
    for (const item of items ?? []) {
      const result = validateFinding({ ...item, analyst: analystName }, ctx);
      if (result.ok) accepted.push(result.finding);
      else rejected.push({ analyst: analystName, title: item?.title ?? '(ohne Titel)', reason: result.reason });
    }
  }
  return { accepted, rejected };
}
