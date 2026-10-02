// Removes comments from the dashboard sources copied into a generated project.
// The generator keeps its comments; the user's repository gets none.

// Go: whole-line and trailing "//" comments outside string literals. Compiler
// directives ("//go:embed", "//go:build") are code and stay.
function stripGoComments(text) {
  const out = [];
  let inRaw = false;
  for (const line of text.split('\n')) {
    if (!inRaw && /^\s*\/\/go:/.test(line)) { out.push(line); continue; }
    if (!inRaw && /^\s*\/\//.test(line)) continue;
    let cut = -1;
    let inStr = false;
    let inRune = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inRaw) { if (ch === '`') inRaw = false; continue; }
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
      if (inRune) { if (ch === '\\') i++; else if (ch === "'") inRune = false; continue; }
      if (ch === '`') inRaw = true;
      else if (ch === '"') inStr = true;
      else if (ch === "'") inRune = true;
      else if (ch === '/' && line[i + 1] === '/') { cut = i; break; }
    }
    out.push(cut === -1 ? line : line.slice(0, cut).replace(/\s+$/, ''));
  }
  return collapseBlankLines(out.join('\n'));
}

// Dockerfile, shell, YAML: whole-line "#" comments. A "#!" shebang stays.
function stripHashComments(text) {
  return collapseBlankLines(text.split('\n').filter(l => !/^\s*#(?!!)/.test(l)).join('\n'));
}

// HTML with inline <style> and <script>: markup comments, CSS/JS block
// comments, and JS whole-line "//" comments.
function stripHtmlComments(text) {
  let s = text.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/(<(style|script)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (all, open, tag, body, close) => {
    let b = body.replace(/\/\*[\s\S]*?\*\//g, '');
    if (tag.toLowerCase() === 'script') b = b.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    return open + b + close;
  });
  return collapseBlankLines(s.split('\n').map(l => (l.trim() === '' ? '' : l)).join('\n'));
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

module.exports = { stripGoComments, stripHashComments, stripHtmlComments };
