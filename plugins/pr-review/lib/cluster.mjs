import { severityRank, raiseSeverity, normalizeForSearch } from './findings.mjs';
import { occurrenceIndex, findingId } from './comment.mjs';

// Was ist EIN Befund? Sein Zitat, nicht seine Zeilennummer.
//
// Bis 0.10.0 war der Gruppenschluessel Datei + Seite, und darin wurden Befunde
// verkettet, deren Zeilenbereiche sich bis auf drei Zeilen naeherten. Das war fuer zwei
// Analysten entworfen. Mit neun verschluckte es eine ganze Dateiregion: im Messlauf vom
// 13.08. trug ein Kommentar fuenf Analysten und fuenf verschiedene Auftraege, ein
// anderer sieben. Fuer einen Fix-Agent, der Auftraege abarbeiten soll, ist das
// unbrauchbar -- und die Severity-Erhoehung feuerte darueber bei sechs von sieben
// Clustern, womit aus roh 6 blocker / 17 major / 5 minor am Ende 6 blocker / 1 major
// wurden.
//
// Die Toleranz war dabei nicht die Ursache, und ein kleinerer Regler nicht der Fix:
// gemessen blieb auch bei Toleranz 0 ein Cluster mit fuenf Analysten stehen, weil ein
// einzelner Bereichsbefund (java-spring meldete 8-25) die Luecken selbst ueberbrueckt.
// Nur eine andere Achse hilft.
//
// Der Schluessel ist deshalb die Finding-ID: Datei + normalisiertes Zitat + Vorkommen +
// Seite. Zwei Analysten, die dasselbe Fragment zitieren, treffen denselben Ort -- das
// ist die einzige Ueberlappung, die dieses Konstrukt beweisen kann. Zwei, die
// verschiedene Fragmente zitieren, haben zwei Befunde, auch wenn beide auf dieselbe
// Zeile zeigen. Das Trennzeichen zwischen den Teilen steckt in findingId und ist dort
// begruendet: ein Dateipfad darf ein Leerzeichen enthalten, ein NUL-Byte nicht.
//
// Nebengewinn, und er ist tragend: alle Items eines Clusters teilen damit ein Zitat.
// Vorher hashte die ID die Evidenz des primaeren Items, und renderComment nahm den
// ev-Hash ebenfalls von items[0] -- bei sieben Auftraegen entschied EINES von sieben
// Zitaten ueber die Identitaet des Threads, und ein Fix an genau diesem Item rotierte
// die ID: computeDelta loeste den Thread auf und postete die sechs Uebrigen als neuen
// Kommentar. Die Bilanz meldete "1 behoben, 1 neu", wo sechs Auftraege unangetastet in
// der Datei standen. Jetzt reden Bedingung (1) und (2) ueber dasselbe Fragment.
function groupKeyFor(finding, haystacks) {
  const haystack = haystacks?.get(finding.file) ?? '';
  const occurrence = occurrenceIndex(haystack, finding.evidence, finding.line);
  return findingId(finding.file, finding.evidence, occurrence, finding.side);
}

function spanOf(finding) {
  return { from: finding.start_line ?? finding.line, to: finding.line };
}

// Rangfolge innerhalb eines Clusters: schwerste Severity zuerst; bei Gleichstand der
// alphabetisch erste Analyst, dann der Evidenztext, dann die Zeile. Die letzten zwei
// Kriterien sind nicht Kosmetik: meldet EIN Analyst zwei gleich schwere Befunde in
// derselben Zeile, sind Severity und Analystenname gleich, und ohne inhaltlichen
// Tiebreak entscheidet die Eingabereihenfolge, welches Item vorne steht. Dieselbe
// Fundstelle bekaeme dann je Lauf eine andere ID -- und der Zweitlauf hielte jeden
// Befund fuer neu, womit die ganze Idempotenz hinfaellig waere.
function byPrimacy(a, b) {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    a.analyst.localeCompare(b.analyst) ||
    a.evidence.localeCompare(b.evidence) ||
    a.line - b.line
  );
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

// Wann ist Mehrfachbetroffenheit ein Redundanzsignal?
//
// Bis 0.10.0 genuegten zwei verschiedene Analysten, egal wie sie die Stelle eingeordnet
// hatten. Gemessen am 13.08. zog damit ein info-Befund ("selbstgebauter Cache") einen
// major auf blocker, und ein minor ("Methodenname beschreibt eine andere Rolle") tat
// dasselbe am History-Endpunkt. Zusammen mit der alten Cluster-Achse blieben von roh
// 6 blocker / 17 major / 5 minor genau 6 blocker / 1 major uebrig -- die Leiter hatte
// fuer den Fix-Agent keine Ordnungsfunktion mehr.
//
// Ein info neben einem major ist kein zweites Urteil "major", sondern ein anderes
// Urteil. Erhoeht wird deshalb nur, wenn zwei verschiedene Analysten die Stelle
// UNABHAENGIG VONEINANDER auf der Basisstufe eingeordnet haben. Das ist dieselbe Zahl
// wie vorher (zwei), nur an der Uebereinstimmung gemessen statt an der Kopfzahl.
function concordantAnalysts(withTitles, baseSeverity) {
  return new Set(withTitles.filter((f) => f.severity === baseSeverity).map((f) => f.analyst)).size;
}

function finalize(acc, file, side, id, analystTitles) {
  const withTitles = acc.raw.map((f) => ({ ...f, analystTitle: analystTitles?.get(f.analyst) ?? f.analyst }));
  const analysts = [...new Set(withTitles.map((f) => f.analyst))];

  // Sortieren VOR dem Entdoppeln, damit items[0] das schwerste Item ist. Seit der
  // Gruppenschluessel das Zitat ist, tragen ALLE Items dasselbe Zitat -- id, ev-Hash und
  // erstes Blockquote koennen also nicht mehr auseinanderfallen, egal welches Item vorne
  // steht. Die Sortierung entscheidet damit nur noch, welcher Auftrag zuerst gelesen
  // wird, und dedupeItems behaelt je Schluessel den ERSTEN Eintrag: der schwerere
  // Auftrag ueberlebt, wenn zwei Analysten denselben formulieren.
  const items = dedupeItems([...withTitles].sort(byPrimacy));

  const baseSeverity = withTitles.reduce(
    (max, f) => (severityRank(f.severity) > severityRank(max) ? f.severity : max),
    'info',
  );
  const multiple = analysts.length >= 2;
  const severity = concordantAnalysts(withTitles, baseSeverity) >= 2 ? raiseSeverity(baseSeverity) : baseSeverity;

  // Die ID wird hier NICHT berechnet, sondern durchgereicht: sie IST der
  // Gruppenschluessel. Sie ein zweites Mal aus items[0] herzuleiten waere dieselbe
  // Rechnung an zwei Stellen -- solange beide uebereinstimmen, faellt das nicht auf, und
  // sobald eine sich aendert, gruppiert der Aggregator nach dem einen Schluessel und
  // beschriftet den Kommentar mit dem anderen. Der Zweitlauf sucht dann einen Thread,
  // dessen ID zu keinem Cluster dieses Laufs passt, und meldet jeden Befund als neu.
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

// Welche Blickrichtungen treffen denselben Ort? Das ist die Groesse, an der ein Roster
// nachgeschaerft wird. Die blosse Zahl der Mehrfach-Cluster taugt dafuer nicht: sie sagt,
// DASS es Ueberlappung gab, nicht ZWISCHEN WEM -- und nur das Paar verraet, welche
// Reviergrenze unscharf ist.
//
// Ein Cluster mit drei Analysten wird in alle drei Paare zerlegt, nicht als Tripel
// gezaehlt: die interessante Information ist, welche Grenzen dort aneinanderstossen.
export function overlapStats(clusters) {
  const pairs = new Map();
  let multi = 0;
  let escalated = 0;

  for (const cluster of clusters ?? []) {
    const names = [...new Set(cluster.analysts ?? [])].sort();
    if (names.length < 2) continue;
    multi++;
    if (cluster.escalated) escalated++;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const key = `${names[i]} + ${names[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    clusters: multi,
    escalated,
    // Haeufigstes Paar zuerst, bei Gleichstand alphabetisch -- damit zwei Laeufe mit
    // denselben Befunden dieselbe Bilanz ergeben und ein Vergleich moeglich ist.
    pairs: [...pairs.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair)),
  };
}

export function clusterFindings(findings, { haystacks, analystTitles } = {}) {
  const groups = new Map();
  for (const finding of findings) {
    const key = groupKeyFor(finding, haystacks);
    if (!groups.has(key)) groups.set(key, { file: finding.file, side: finding.side, raw: [] });
    groups.get(key).raw.push(finding);
  }

  const clusters = [];
  for (const [id, { file, side, raw }] of groups) {
    // Der Anker deckt alle Verankerungen des Zitats ab: ein Analyst zitiert es
    // punktuell, ein anderer als Bereich. Ohne die Vereinigung zeigte der Kommentar
    // nur auf einen Teil des Befundes.
    const from = Math.min(...raw.map((f) => spanOf(f).from));
    const to = Math.max(...raw.map((f) => spanOf(f).to));
    clusters.push(finalize({ from, to, raw }, file, side, id, analystTitles));
  }

  // Die ID als letztes Kriterium, und das ist seit der Zitat-Achse der Normalfall, kein
  // Randfall: zwei Analysten zitieren verschiedene Fragmente derselben Zeile und
  // bekommen zwei Kommentare am selben Anker. Severity, Analystenzahl, Datei, Zeile und
  // Seite sind dann alle gleich -- ohne inhaltlichen Tiebreak entscheidet die Reihenfolge
  // der Gruppierung, also die Eingabereihenfolge der Analystendateien, in welcher
  // Reihenfolge die Kommentare im PR stehen. Zwei Laeufe mit denselben Befunden ergaeben
  // dann verschiedene Reviews.
  clusters.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.analysts.length - a.analysts.length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.side.localeCompare(b.side) ||
      a.id.localeCompare(b.id),
  );
  return clusters;
}
