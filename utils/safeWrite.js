// Writes inside the project that never follow a symlink: a repository can make any generated path a
// link to a file outside it, and a plain write would overwrite whatever the link points at.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SymlinkError extends Error {
  constructor(rel, link) {
    super(`${link === rel ? `${rel} is a symlink` : `${link} (on the way to ${rel}) is a symlink`} - Flarops would write wherever it points. Replace it with a real ${link === rel ? 'file' : 'directory'} (or remove it) and run the command again.`);
    this.path = rel;
    this.link = link;
  }
}

// The path relative to root, refusing one that leaves it.
function relativeTo(root, target) {
  const rel = path.relative(root, path.resolve(root, target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${target} is not inside ${root}`);
  }
  return rel;
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Throws a SymlinkError when the target, or any directory between root and it, is a symlink.
// { parentsOnly: true } leaves the target itself out: removing a link removes only the link.
function assertNoSymlink(root, target, { parentsOnly = false } = {}) {
  const rel = relativeTo(root, target);
  const parts = rel.split(path.sep);
  const upTo = parentsOnly ? parts.length - 1 : parts.length;
  for (let i = 1; i <= upTo; i++) {
    const sub = parts.slice(0, i).join(path.sep);
    const stat = lstatOrNull(path.join(root, sub));
    if (stat && stat.isSymbolicLink()) throw new SymlinkError(rel.split(path.sep).join('/'), sub.split(path.sep).join('/'));
  }
  return rel;
}

// Creates the directories on the way one at a time, so none is created through a link.
function ensureDirs(root, rel) {
  const parts = rel.split(path.sep).slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = path.join(root, ...parts.slice(0, i));
    const stat = lstatOrNull(dir);
    if (stat && stat.isSymbolicLink()) throw new SymlinkError(rel.split(path.sep).join('/'), parts.slice(0, i).join('/'));
    if (stat && !stat.isDirectory()) throw new Error(`${parts.slice(0, i).join('/')} is a file, not a directory`);
    if (!stat) {
      try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
}

// Writes through a new temporary file in the same directory, then renames it over the target: a link
// swapped in at the target meanwhile is replaced, not followed. `mode` sets the permissions from the
// first byte (0o600 for secrets); without it an existing file keeps its own.
function safeWriteFile(root, target, content, { mode } = {}) {
  const rel = assertNoSymlink(root, target);
  ensureDirs(root, rel);
  const file = path.join(root, rel);
  const existing = lstatOrNull(file);
  const finalMode = mode !== undefined ? mode : (existing && existing.isFile() ? existing.mode & 0o777 : undefined);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', finalMode !== undefined ? finalMode : 0o666);
  try {
    try {
      if (finalMode !== undefined) fs.fchmodSync(fd, finalMode);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* already gone */ }
    throw e;
  }
}

// Removes a file, never through a linked directory.
function safeUnlink(root, target) {
  const rel = assertNoSymlink(root, target, { parentsOnly: true });
  fs.unlinkSync(path.join(root, rel));
}

// Reads a file inside the project; null when absent. Refuses a link, whose target may be anything.
function safeReadFile(root, target, encoding = 'utf8') {
  const rel = assertNoSymlink(root, target);
  try { return fs.readFileSync(path.join(root, rel), encoding); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

module.exports = { safeWriteFile, safeUnlink, safeReadFile, assertNoSymlink, SymlinkError };
