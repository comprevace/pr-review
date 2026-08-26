import { SEVERITIES } from './findings.mjs';
import { SEVERITY_ICON } from './comment.mjs';

function bullet(lines) {
  return lines.length === 0 ? '' : lines.map((l) => `- ${l}`).join('\n');
}

function groupReasons(rejected) {
  const byReason = new Map();
  for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
}

export function renderSummary(input) {
  const {
    pluginVersion, analystsRun, analystsSkipped, analystsFailed, counts,
    rejected, anchorless, capped, skippedExisting, verify, meta, overlap,
  } = input;

  const out = ['## PR review — summary', ''];

  if (verify) {
    out.push(
      `**Second pass:** ${verify.resolved} fixed · ${verify.stillOpen} still open · ${verify.fresh} new`,
      '',
    );
    // Eigene, fette Zeile statt eines vierten Postens in der Aufzaehlung oben: ein
    // Rueckfall ist das Interessanteste, was ein Zweitlauf finden kann -- ein Befund,
    // der schon einmal als behoben aufgeloest war und wieder da ist. Er darf nicht
    // leiser sein als ein neuer Befund. `?? 0` haelt aeltere Aufrufer lesbar, die
    // verify ohne dieses Feld liefern.
    const regressed = verify.regressed ?? 0;
    if (regressed > 0) {
      out.push(
        `**⚠ Regression: ${regressed} ${regressed === 1 ? 'finding was' : 'findings were'} already resolved as ` +
          `fixed and ${regressed === 1 ? 'is' : 'are'} back.** The old thread stays resolved; ` +
          'the finding is posted again as a comment on the code.',
        '',
      );
    }
  }

  const found = SEVERITIES.slice().reverse()
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${SEVERITY_ICON[s]} ${s}: ${counts[s]}`);
  out.push('**Findings:** ' + (found.length ? found.join(' · ') : 'none'), '');

  out.push('**Analysts**', '');
  out.push(bullet([
    `ran: ${analystsRun.join(', ') || 'none'}`,
    ...analystsSkipped.map((a) => `not started — ${a.name}: ${a.reason}`),
    ...analystsFailed.map((a) => `**failed — ${a.name}: ${a.reason}**`),
  ]), '');

  if (rejected.length > 0) {
    out.push(`**Discarded: ${rejected.length}**`, '');
    out.push(bullet(groupReasons(rejected).map(([reason, n]) => `${n}× ${reason}`)), '');
  }

  if (anchorless.length > 0) {
    out.push(`**Without an anchor: ${anchorless.length}**`, '');
    out.push('These lines lie outside the diff and cannot be commented on inline.', '');
    out.push(bullet(anchorless.map((c) => `\`${c.file}:${c.line}\` — ${c.items[0]?.title ?? ''} (${c.severity})`)), '');
  }

  if (capped.length > 0) {
    out.push(`**Capped: ${capped.length}**`, '');
    out.push(
      'The most severe findings were posted. This number usually means: **the PR is too large** — ' +
      'one story, one PR makes it reviewable again.',
      '',
    );
    out.push(bullet(capped.map((c) => `\`${c.file}:${c.line}\` — ${c.items[0]?.title ?? ''} (${c.severity})`)), '');
  }

  if (skippedExisting.length > 0) {
    out.push(`**Already commented: ${skippedExisting.length}** (not posted again)`, '');
  }

  // Der Block, an dem sich das Roster nachschaerfen laesst. Er steht bewusst mit dem
  // deutenden Satz da: ohne ihn liest man ein haeufiges Paar als Qualitaetssignal
  // ("zwei Pruefer sind sich einig") statt als das, was es meistens ist -- eine
  // Reviergrenze, die nicht trennt.
  if (overlap?.clusters > 0) {
    out.push(
      `**Overlapping findings:** ${overlap.clusters} clusters with more than one analyst, `
      + `${overlap.escalated} of them raised in severity`,
      '',
      bullet(overlap.pairs.map((p) => `\`${p.pair}\` — ${p.count}×`)),
      '',
      '<sub>A pair that shows up together often points to a blurred territory '
      + 'boundary rather than to something genuinely hit from two sides.</sub>',
      '',
    );
  }

  const gaps = [];
  if (meta?.spec_missing) gaps.push('No spec file found — spec fidelity could not check against acceptance criteria.');
  if (meta?.conventions_missing) gaps.push('No `CLAUDE.md` in the repository — the conventions check was skipped.');
  if (meta?.missing_tests?.length) {
    gaps.push(`Without a corresponding test file: ${meta.missing_tests.map((f) => `\`${f}\``).join(', ')}`);
  }
  // Eine gekappte Nachbarschaft aendert, wie die Bilanz zu lesen ist: Stimmigkeit hat
  // dort nur einen Ausschnitt des Verzeichnisses gesehen, und "kein Musterbruch" ist dann
  // keine Aussage ueber das Verzeichnis. In meta.json allein erreicht das niemanden, der
  // die Bilanz liest.
  if (meta?.siblings_truncated?.length) {
    gaps.push(
      `Neighbourhood capped in: ${meta.siblings_truncated.map((d) => `\`${d}\``).join(', ')} — `
      + 'consistency saw only part of those directories.',
    );
  }
  if (gaps.length > 0) {
    out.push('**Gaps in the input**', '', bullet(gaps), '');
  }

  out.push(
    '**Osmani test** — the three questions a merge has to answer:',
    '',
    '1. What changed?',
    '2. Why is it safe?',
    '3. What happens if we are wrong?',
    '',
    'This review does not answer them. It supplies the material for doing so.',
    '',
    '---',
    '',
    `<sub>This is a **signal, not a gate**. No approval is given and no merge is influenced. ` +
      `pr-review ${pluginVersion} · analysts: ${analystsRun.join(', ') || 'none'}</sub>`,
  );

  return out.filter((line) => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}
