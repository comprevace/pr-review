import { parseMarker, parseEvidence, evidenceHash, MARKER_VERSION } from './comment.mjs';
import { normalizeForSearch } from './findings.mjs';

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { body } } }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

export async function fetchThreads({ repo, number, ghGraphql }) {
  const [owner, name] = repo.split('/');
  const threads = [];
  let cursor = null;
  for (;;) {
    const vars = { owner, repo: name, number };
    if (cursor !== null) vars.cursor = cursor;
    const data = await ghGraphql(THREADS_QUERY, vars);
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const body = node.comments?.nodes?.[0]?.body ?? '';
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        marker: parseMarker(body),
        evidence: parseEvidence(body),
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return threads;
}

export async function resolveThread({ threadId, ghGraphql }) {
  await ghGraphql(RESOLVE_MUTATION, { threadId });
}

// Behoben verlangt ZWEI Bedingungen:
//   (1) kein Analyst meldet den Befund erneut, UND
//   (2) die zitierte Evidenz steht nicht mehr im Bundle.
// Nur (2) zu pruefen waere trivial erfuellbar, indem man die auffaellige Zeile
// umformuliert. Nur (1) zu pruefen wuerde einen Befund aufloesen, den ein
// ausgefallener Analyst nur nicht gemeldet hat. Der Evidenz-Hash im Marker macht
// (2) ohne Zusatzspeicher pruefbar.
//
// Vier Ausgaenge, nicht drei: fresh (nie kommentiert), stillOpen (offen und erneut
// gemeldet), resolvable (beide Bedingungen erfuellt) und regressed (war aufgeloest,
// wird wieder gemeldet).
export function computeDelta({ clusters, threads, haystacks }) {
  const reportedIds = new Set(clusters.map((c) => c.id));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const knownIds = new Set(threads.map((t) => t.marker?.id).filter(Boolean));
  // Offene Threads getrennt fuehren: traegt derselbe Befund sowohl einen aufgeloesten
  // als auch einen offenen Thread, ist er bereits ueber stillOpen bilanziert und darf
  // nicht zusaetzlich als Rueckfall gezaehlt und erneut gepostet werden.
  const openIds = new Set(threads.filter((t) => !t.isResolved).map((t) => t.marker?.id).filter(Boolean));

  // Zeilenweise Teilstringsuche, genau wie validateFinding und occurrenceIndex.
  // Die Frage lautet "steht das Zitat noch woertlich irgendwo in dieser Datei",
  // nicht "ist die ganze Zeile unveraendert": ein Analyst zitiert das schuldige
  // Fragment, nicht die komplette Zeile. Ein Zeilenvergleich sagte deshalb fast
  // immer "verschwunden" -- Bedingung (2) waere wertlos und die
  // Zwei-Bedingungen-Regel faktisch eine Ein-Bedingungs-Regel.
  const lines = [];
  for (const text of haystacks?.values() ?? []) {
    for (const line of String(text).split('\n')) {
      const normalized = normalizeForSearch(line);
      if (normalized !== '') lines.push(normalized);
    }
  }
  const stillPresent = (evidence) => {
    const needle = normalizeForSearch(evidence ?? '');
    return needle !== '' && lines.some((line) => line.includes(needle));
  };

  const fresh = clusters.filter((c) => !knownIds.has(c.id));
  const stillOpen = [];
  const resolvable = [];
  const regressed = [];
  const regressedIds = new Set();

  for (const thread of threads) {
    if (!thread.marker) continue;

    // Rueckfall: der Thread war aufgeloest, der Befund wird jetzt wieder gemeldet --
    // derselbe Code ist zurueck. Ohne diesen Zweig verschwindet er restlos: knownIds
    // enthaelt auch aufgeloeste Threads, damit ist er nicht "fresh", und ein
    // bedingungsloses continue auf isResolved liesse ihn auch nicht in stillOpen
    // landen. Weder gepostet noch gezaehlt -- und ein Rueckfall ist das Interessanteste,
    // was ein Zweitlauf finden kann.
    if (thread.isResolved) {
      if (reportedIds.has(thread.marker.id) && !openIds.has(thread.marker.id) && !regressedIds.has(thread.marker.id)) {
        regressedIds.add(thread.marker.id);
        regressed.push(clusterById.get(thread.marker.id));
      }
      continue;
    }

    if (reportedIds.has(thread.marker.id)) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    // Ohne ev-Feld oder ohne lesbares Zitat im Kommentartext fehlt Bedingung (2). Dann
    // bleibt der Thread offen -- lieber einer zu viel als ein stillschweigend
    // geschlossener echter Befund.
    if (thread.marker.ev === null || !thread.evidence) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    // Ein Marker aus einem aelteren ID-Schema: dieselbe Vorsicht, aber aus dem anderen
    // Grund -- hier fehlt Bedingung (1). Seine ID wurde nach einer anderen Regel
    // gebildet und kann in reportedIds gar nicht mehr auftauchen, egal wie oft der
    // Befund erneut gemeldet wird. Der Test "reportedIds.has(id)" oben ist fuer ihn
    // also kein Test, sondern ein garantiertes Nein. Ohne diesen Zweig kollabierte die
    // Zwei-Bedingungen-Regel fuer die ganze Klasse alter Threads auf eine, und eine
    // umformulierte Zeile genuegte, um einen Befund als behoben zu schliessen, waehrend
    // er unter neuer ID gerade wieder gepostet wird. Ein Mensch loest diese Threads
    // einmal von Hand auf; das ist der Preis der Rotation.
    if (thread.marker.version !== MARKER_VERSION) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    // Der Hash im Marker beglaubigt den gelesenen Zitattext. parseEvidence nimmt das
    // ERSTE Blockquote, und darueber kann etwas stehen, das wie ein Zitat aussieht --
    // ein Fliesstext des Analysten, eine menschliche Bearbeitung des Kommentars.
    // Passt der Hash nicht, ist der gelesene Text nicht der, aus dem der Marker
    // entstand: dann fehlt Bedingung (2), und der Thread bleibt offen, statt auf dem
    // falschen Text zu entscheiden. Das ist derselbe Grund, aus dem MARKER_RE am
    // Textende verankert ist -- und damit hat ev eine zweite, echte Aufgabe.
    if (evidenceHash(thread.evidence) !== thread.marker.ev) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    if (stillPresent(thread.evidence)) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    resolvable.push(thread.id);
  }

  return {
    fresh,
    stillOpen,
    resolvable,
    regressed,
    counts: {
      fresh: fresh.length,
      stillOpen: stillOpen.length,
      resolved: resolvable.length,
      regressed: regressed.length,
    },
  };
}
