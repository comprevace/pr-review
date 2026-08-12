import { parseMarker, evidenceHash } from './comment.mjs';
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
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        marker: parseMarker(node.comments?.nodes?.[0]?.body ?? ''),
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
export function computeDelta({ clusters, threads, haystacks }) {
  const reportedIds = new Set(clusters.map((c) => c.id));
  const knownIds = new Set(threads.map((t) => t.marker?.id).filter(Boolean));

  // Alle Evidenz-Hashes, die im aktuellen Bundle noch vorkommen. Der Marker traegt
  // nur den Hash, also wird zeilenweise gehasht und verglichen.
  const presentHashes = new Set();
  for (const text of haystacks?.values() ?? []) {
    for (const line of String(text).split('\n')) {
      const normalized = normalizeForSearch(line);
      if (normalized !== '') presentHashes.add(evidenceHash(normalized));
    }
  }

  const fresh = clusters.filter((c) => !knownIds.has(c.id));
  const stillOpen = [];
  const resolvable = [];

  for (const thread of threads) {
    if (!thread.marker || thread.isResolved) continue;

    if (reportedIds.has(thread.marker.id)) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    // Ohne ev-Feld (Kommentar aus einer aelteren Version) fehlt Bedingung (2).
    // Dann bleibt der Thread offen -- lieber ein offener Thread zu viel als ein
    // stillschweigend aufgeloester Befund.
    if (thread.marker.ev === null) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    if (presentHashes.has(thread.marker.ev)) {
      stillOpen.push(thread.marker.id);
      continue;
    }
    resolvable.push(thread.id);
  }

  return {
    fresh,
    stillOpen,
    resolvable,
    counts: { fresh: fresh.length, stillOpen: stillOpen.length, resolved: resolvable.length },
  };
}
