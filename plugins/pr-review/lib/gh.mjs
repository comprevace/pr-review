// Einziger Ort mit Prozessaufrufen nach aussen. gh liefert Auth und Transport;
// wir halten keinen Token und schreiben keinen in eine Datei.
import { execFile } from 'node:child_process';

function run(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`gh ${args.join(' ')} failed: ${stderr.trim() || err.message}`);
        // gh schreibt den HTTP-Status in stderr, z. B. "HTTP 404".
        const m = /HTTP (\d{3})/.exec(stderr);
        if (m) e.status = Number(m[1]);
        return reject(e);
      }
      resolve(stdout);
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

export async function ghApi(endpoint, { method = 'GET', paginate = false, body } = {}) {
  const args = ['api', endpoint, '-H', 'Accept: application/vnd.github+json'];
  if (method !== 'GET') args.push('-X', method);
  if (paginate) args.push('--paginate', '--slurp');
  let stdin;
  if (body !== undefined) {
    args.push('--input', '-');
    stdin = JSON.stringify(body);
  }
  const out = await run(args, stdin);
  const parsed = out.trim() === '' ? null : JSON.parse(out);
  // --slurp verschachtelt Seiten zu einem Array von Arrays; flach machen.
  if (paginate && Array.isArray(parsed)) return parsed.flat();
  return parsed;
}

export async function ghGraphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    const flag = typeof value === 'number' ? '-F' : '-f';
    args.push(flag, `${key}=${value}`);
  }
  const out = await run(args);
  const parsed = JSON.parse(out);
  if (parsed.errors?.length) {
    throw new Error(`GraphQL: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }
  return parsed.data;
}

export async function currentRepo() {
  const out = await run(['repo', 'view', '--json', 'nameWithOwner']);
  return JSON.parse(out).nameWithOwner;
}
