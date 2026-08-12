import { isCommentable } from './diff.mjs';
import { renderComment } from './comment.mjs';
import { severityRank } from './findings.mjs';

export const DEFAULT_CAP = 25;

// POST /pulls/{n}/reviews ist all-or-nothing: ein einziger Anker ausserhalb des
// Diffs quittiert die API mit 422 und setzt KEINEN Kommentar. Deshalb wird hier
// vorvalidiert, statt sich auf die Analysten zu verlassen.
export function buildPayload(clusters, { commentable, previousIds = new Set(), cap = DEFAULT_CAP, renderBody }) {
  const skippedExisting = [];
  const anchorless = [];
  const anchored = [];

  for (const cluster of clusters) {
    if (previousIds.has(cluster.id)) {
      skippedExisting.push(cluster);
      continue;
    }
    const map = commentable.get(cluster.file);
    if (!map || !isCommentable(map, cluster.side, cluster.line)) {
      anchorless.push(cluster);
      continue;
    }
    anchored.push(cluster);
  }

  anchored.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.analysts.length - a.analysts.length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const posted = anchored.slice(0, cap);
  const capped = anchored.slice(cap);

  const comments = posted.map((cluster) => {
    const comment = {
      path: cluster.file,
      line: cluster.line,
      side: cluster.side,
      body: renderComment(cluster),
    };
    const map = commentable.get(cluster.file);
    // Ein Bereichskommentar braucht auch die Startzeile im Diff. Sonst lieber
    // einzeilig kommentieren als das ganze Review riskieren.
    if (cluster.start_line !== null && isCommentable(map, cluster.side, cluster.start_line)) {
      comment.start_line = cluster.start_line;
      comment.start_side = cluster.side;
    }
    return comment;
  });

  const report = { posted, anchorless, capped, skippedExisting };
  return { body: renderBody(report), event: 'COMMENT', comments, report };
}
