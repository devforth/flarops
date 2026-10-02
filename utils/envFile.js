// deploy/.env and the set of keys already in it.

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
