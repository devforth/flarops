// A branch name that is safe as a YAML string and a shell word. Anything else, valid git refs
// such as "x$(cmd)" or "{a}" included, is refused rather than escaped.
function safeBranch(name) {
  const s = typeof name === 'string' ? name : '';
  if (!/^[A-Za-z0-9._/-]+$/.test(s) || s.includes('..') || s.startsWith('-')) return null;
  return s;
}

module.exports = { safeBranch };
