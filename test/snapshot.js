//
// Snapshot of everything a generation produces, so a refactor that must not
// change the output is proven by diff rather than by reading it.
//
// Two things make a naive snapshot useless here, and both are handled below:
//
//  * Secrets. Every run mints fresh passwords, an SSH keypair and a dashboard
//    password hash. Those are scrubbed to a fixed placeholder - the snapshot
//    asserts that a value of that SHAPE is present in that PLACE, which is the
//    part a refactor can break, and cannot assert the bytes.
//  * The dashboard. deploy/dashboard/ is a verbatim copy of the repo's own Go
//    source; snapshotting it would mean every dashboard edit rewrites all
//    sixteen snapshots for no signal. Its files are listed by name (so one
//    going missing is still caught) and their contents are not compared.
//
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Listed by name, contents not compared.
const OPAQUE = [/^\.keys\//, /^deploy\/dashboard\//];

function walk(root, base = '') {
  let out = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out = out.concat(walk(root, rel));
    else out.push(rel);
  }
  return out;
}

// Replace what is random with a marker that still records the shape, so a
// refactor that drops a password or emits it in the wrong encoding fails.
function scrub(text) {
  return text
    // PEM blocks - the generated deploy key.
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<PEM>')
    .replace(/ssh-(rsa|ed25519) [A-Za-z0-9+/=]+( [^\s"]*)?/g, 'ssh-$1 <PUBKEY>')
    // PBKDF2 hash written for the dashboard login: salt$hash, both base64.
    .replace(/[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{20,}/g, '<PBKDF2>')
    // Generated passwords: long hex or base64 runs on the right of an
    // assignment or a YAML key. Anchored so ordinary words are left alone.
    .replace(/([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY|HASH)[A-Z0-9_]*\s*[:=]\s*"?)[A-Za-z0-9+/=_-]{16,}("?)/g, '$1<SECRET>$2')
    .replace(/(:\/\/[^:@\s"]+:)[A-Za-z0-9+/=_-]{16,}(@)/g, '$1<SECRET>$2');
}

function capture(dir) {
  const files = walk(dir).sort();
  const parts = ['# files', ...files.map(f => `  ${f}`), ''];
  for (const rel of files) {
    if (OPAQUE.some(re => re.test(rel))) continue;
    const abs = path.join(dir, rel);
    const buf = fs.readFileSync(abs);
    // A NUL byte means binary; record its presence, not its bytes.
    const body = buf.includes(0) ? `<binary ${buf.length} bytes>` : scrub(buf.toString('utf8'));
    parts.push(`# ===== ${rel}`, body.replace(/\s+$/, ''), '');
  }
  return parts.join('\n');
}

// First differing line, with a little context - a whole-file diff of a 3000
// line snapshot tells nobody anything.
function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const at = a.slice(Math.max(0, i - 3), i).map(l => `   ${l}`).join('\n');
    return `line ${i + 1}, after:\n${at}\n  -${a[i] === undefined ? '<end of snapshot>' : a[i]}\n  +${b[i] === undefined ? '<end of output>' : b[i]}`;
  }
  return null;
}

module.exports = { capture, firstDifference };
