// deploy/.env - the operator's list of what to create as GitHub secrets.
//
// It is generated output, but it was also being used as the GENERATOR's own
// memory: "have I already written this key?" was answered by reading the file
// back off disk and running a regex over it, once per key, from nine places
// spread over nine hundred lines of init.js. That works, but it means the set
// of keys has no owner - it is whatever the file happens to say at the moment
// you look - and every caller has to remember to re-read.
//
// The keys live here instead. The file keeps the write order it had: sections
// are appended as each phase discovers them, because that order is what makes
// the file readable (infrastructure, then what was found in the project, then
// what a service turned out to need, and the forty-line deploy key last).
//
// The set is seeded from an EXISTING file when there is one, because a re-run
// must not append a key the previous run already wrote.

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class EnvFile {
  constructor(fs, filePath) {
    this.fs = fs;
    this.path = filePath;
    this.keys = new Set();
    this.load();
  }

  // Reads the keys a previous run left behind. Called once at construction;
  // after that the set is authoritative and the file is never read to answer
  // a question about it.
  load() {
    let text = '';
    try { text = this.fs.readFileSync(this.path, 'utf8'); } catch (e) { return; }
    for (const line of text.split('\n')) {
      const m = line.match(KEY_LINE);
      if (m) this.keys.add(m[1]);
    }
  }

  exists() {
    return this.fs.existsSync(this.path);
  }

  has(key) {
    return this.keys.has(key);
  }

  // Records every key in `text` as present. Used by the initial write and by
  // the section appends, which carry several keys and their comments at once.
  track(text) {
    for (const line of String(text).split('\n')) {
      const m = line.match(KEY_LINE);
      if (m) this.keys.add(m[1]);
    }
  }

  write(content) {
    this.fs.writeFileSync(this.path, content);
    this.track(content);
  }

  append(text) {
    this.fs.appendFileSync(this.path, text);
    this.track(text);
  }

  // Drops one key's line. Spring's relaxed binding means a key found in the
  // project is never read by the container under that exact name, so demanding
  // it would mislead whoever sets it.
  removeKey(key) {
    this.keys.delete(key);
    try {
      const current = this.fs.readFileSync(this.path, 'utf8');
      const without = current.replace(new RegExp('^' + escapeRegex(key) + '=.*\\n?', 'm'), '');
      if (without !== current) {
        this.fs.writeFileSync(this.path, without);
        this.fs.chmodSync(this.path, 0o600);
        return true;
      }
    } catch (e) { /* not written yet, or already clean */ }
    return false;
  }

  read() {
    try { return this.fs.readFileSync(this.path, 'utf8'); } catch (e) { return ''; }
  }
}

module.exports = { EnvFile };
