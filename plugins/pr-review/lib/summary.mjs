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
    rejected, anchorless, capped, skippedExisting, verify, meta,
  } = input;

  const out = ['## PR-Review — Bilanz', ''];

  if (verify) {
    out.push(
      `**Zweitlauf:** ${verify.resolved} behoben · ${verify.stillOpen} weiterhin offen · ${verify.fresh} neu`,
      '',
    );
  }

  const found = SEVERITIES.slice().reverse()
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${SEVERITY_ICON[s]} ${s}: ${counts[s]}`);
  out.push('**Befunde:** ' + (found.length ? found.join(' · ') : 'keine'), '');

  out.push('**Analysten**', '');
  out.push(bullet([
    `gelaufen: ${analystsRun.join(', ') || 'keine'}`,
    ...analystsSkipped.map((a) => `nicht gestartet — ${a.name}: ${a.reason}`),
    ...analystsFailed.map((a) => `**ausgefallen — ${a.name}: ${a.reason}**`),
  ]), '');

  if (rejected.length > 0) {
    out.push(`**Verworfen: ${rejected.length}**`, '');
    out.push(bullet(groupReasons(rejected).map(([reason, n]) => `${n}× ${reason}`)), '');
  }

  if (anchorless.length > 0) {
    out.push(`**Ohne Ankerpunkt: ${anchorless.length}**`, '');
    out.push('Diese Zeilen liegen außerhalb des Diffs und können nicht inline kommentiert werden.', '');
    out.push(bullet(anchorless.map((c) => `\`${c.file}:${c.line}\` — ${c.items[0]?.title ?? ''} (${c.severity})`)), '');
  }

  if (capped.length > 0) {
    out.push(`**Gekappt: ${capped.length}**`, '');
    out.push(
      'Es wurden die schwersten Befunde gepostet. Diese Zahl heißt meistens: **der PR ist zu groß** — ' +
      'eine Story, ein PR macht ihn wieder reviewbar.',
      '',
    );
    out.push(bullet(capped.map((c) => `\`${c.file}:${c.line}\` — ${c.items[0]?.title ?? ''} (${c.severity})`)), '');
  }

  if (skippedExisting.length > 0) {
    out.push(`**Bereits kommentiert: ${skippedExisting.length}** (nicht erneut gesetzt)`, '');
  }

  const gaps = [];
  if (meta?.spec_missing) gaps.push('Keine Spec-Datei auffindbar — Spec-Treue konnte nicht gegen Akzeptanzkriterien prüfen.');
  if (meta?.conventions_missing) gaps.push('Kein `CLAUDE.md` im Repo — Konventionsprüfung fiel weg.');
  if (meta?.missing_tests?.length) {
    gaps.push(`Ohne zugehörige Testdatei: ${meta.missing_tests.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (gaps.length > 0) {
    out.push('**Lücken in der Eingabe**', '', bullet(gaps), '');
  }

  out.push(
    '**Osmani-Test** — die drei Fragen, die ein Merge beantworten muss:',
    '',
    '1. Was hat sich geändert?',
    '2. Warum ist es sicher?',
    '3. Was passiert, wenn wir uns irren?',
    '',
    'Dieses Review beantwortet sie nicht. Es liefert Material dafür.',
    '',
    '---',
    '',
    `<sub>Dies ist ein **Signal, kein Gate**. Es erfolgt kein Approve und kein Merge-Einfluss. ` +
      `pr-review ${pluginVersion} · Analysten: ${analystsRun.join(', ') || 'keine'}</sub>`,
  );

  return out.filter((line) => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}
