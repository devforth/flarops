// Snapshot of everything a generation produces. Random values are scrubbed to markers; the dashboard
// copy is listed by name only.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
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

function scrub(text) {
  return text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<PEM>')
    .replace(/ssh-(rsa|ed25519) [A-Za-z0-9+/=]+( [^\s"]*)?/g, 'ssh-$1 <PUBKEY>')
    .replace(/[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{20,}/g, '<PBKDF2>')
    // Generated passwords; a SCREAMING_SNAKE value is a secret's NAME and is kept.
    .replace(/([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY|HASH)[A-Z0-9_]*[ \t]*[:=][ \t]*"?)([A-Za-z0-9+/=_-]{16,})("?)/g,
      (all, lead, value, tail) => /^[A-Z][A-Z0-9_]*$/.test(value) ? all : `${lead}<SECRET>${tail}`)
    .replace(/(:\/\/[^:@\s"]+:)[A-Za-z0-9+/=_-]{16,}(@)/g, '$1<SECRET>$2');
}

function capture(dir) {
  const files = walk(dir).sort();
  const parts = ['# files', ...files.map(f => `  ${f}`), ''];
  for (const rel of files) {
    if (OPAQUE.some(re => re.test(rel))) continue;
    const abs = path.join(dir, rel);
    const buf = fs.readFileSync(abs);
    const body = buf.includes(0) ? `<binary ${buf.length} bytes>` : scrub(buf.toString('utf8'));
    parts.push(`# ===== ${rel}`, body.replace(/\s+$/, ''), '');
  }
  return parts.join('\n');
}

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
