// A reader for the YAML subset flarops.yaml is written in.
//
// Flarops carries no runtime dependencies, and this file is the one piece of
// generated output a PERSON edits by hand - so unlike the ad-hoc scans
// elsewhere in the codebase, it has to fail loudly on input it cannot
// represent rather than quietly returning something plausible. Everything it
// refuses is reported with a line number.
//
// Supported: nested mappings by indentation, sequences of scalars and of
// mappings, quoted and bare scalars, integers, booleans, null, comments and
// blank lines, flow collections ([1, 2] and {a: 1}), and anchors/aliases
// (&name, *name, << merge keys). Not supported, and rejected rather than
// guessed at: tabs, multi-line block scalars (| and >), multiple documents.
//
// Anchors are here because they are ordinary YAML that any other tool accepts,
// and refusing them would make flarops.yaml a file that only this parser can
// read. They also used to be worse than unsupported: "env: *shared" with
// nothing indented under it parsed as the STRING "*shared", and the env block
// it produced had one variable per character of that string.

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return null;

  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    if (text.length < 2 || text[text.length - 1] !== quote) {
      throw new YamlError('unterminated quoted string', lineNo);
    }
    const body = text.slice(1, -1);
    if (quote === "'") return body.replace(/''/g, "'");
    return body.replace(/\\(["\\/nrt])/g, (m, c) =>
      ({ '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t' }[c]));
  }

  if (text === '|' || text === '>' || text.startsWith('|') || text.startsWith('>')) {
    throw new YamlError('block scalars (| and >) are not supported here', lineNo);
  }

  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return parseFloat(text);
  return text;
}


// Splits "a, b, {c: d}" at top-level commas only - quotes and nested brackets
// hold their contents together.
function splitFlow(body, lineNo) {
  if (body.trim() === '') return [];
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0 || quote) throw new YamlError('unclosed flow collection', lineNo);
  parts.push(body.slice(start));
  return parts;
}

// [1, 2] and {a: 1} - the shapes an agent writes without thinking about it,
// and which docker-compose files are full of.
function parseFlowCollection(text, lineNo, resolve) {
  const body = text.slice(1, -1);
  if (text[0] === '[') {
    return splitFlow(body, lineNo).map(p => resolve(p.trim(), lineNo));
  }
  const out = {};
  for (const pair of splitFlow(body, lineNo)) {
    const colon = pair.indexOf(':');
    if (colon === -1) throw new YamlError(`expected "key: value" inside { }, found ${JSON.stringify(pair.trim())}`, lineNo);
    out[parseScalar(pair.slice(0, colon), lineNo)] = resolve(pair.slice(colon + 1).trim(), lineNo);
  }
  return out;
}

// A node referenced by an alias is copied rather than shared: sync writes
// through these objects, and two services silently pointing at one object
// would make an edit to either change both.
function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepCopy(v)]));
  }
  return value;
}

// Strips a trailing comment, but only one introduced by whitespace-then-# and
// not inside quotes - "#" is a perfectly ordinary character in a password or a
// URL fragment.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parse(text) {
  const rows = [];
  text.split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^\s*$/.test(raw)) return;
    if (/^\s*#/.test(raw)) return;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) {
      throw new YamlError('tabs cannot be used for indentation in YAML', lineNo);
    }
    if (raw.trim() === '---' || raw.trim() === '...') {
      throw new YamlError('multiple documents are not supported here', lineNo);
    }
    const content = stripComment(raw).replace(/\s+$/, '');
    if (content.trim() === '') return;
    rows.push({ indent: content.length - content.trimStart().length, text: content.trim(), lineNo });
  });

  let pos = 0;
  // &name -> the node it labelled, for *name to copy later.
  const anchors = new Map();

  // Turns the text to the right of a "key:" or a "- " into a value, handling
  // the three things that can appear there besides a plain scalar: an anchor
  // that labels it, an alias that stands for one, and a flow collection.
  function resolveInline(text, lineNo) {
    const trimmed = text.trim();
    if (trimmed.startsWith('*')) {
      const name = trimmed.slice(1).trim();
      if (!anchors.has(name)) {
        throw new YamlError(`*${name} refers to an anchor that has not been defined above it`, lineNo);
      }
      return deepCopy(anchors.get(name));
    }
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const closer = trimmed[0] === '[' ? ']' : '}';
      // Without this an unclosed "[1, 2" falls through to parseScalar and
      // becomes the literal string "[1, 2" - a wrong answer where the author
      // can only have meant a list.
      if (!trimmed.endsWith(closer)) {
        throw new YamlError(`unclosed flow collection - expected a ${closer}`, lineNo);
      }
      return parseFlowCollection(trimmed, lineNo, resolveInline);
    }
    return parseScalar(trimmed, lineNo);
  }

  // Splits a leading "&name" off, returning [anchorName, whatIsLeft].
  function takeAnchor(text) {
    const m = String(text).match(/^&(\S+)\s*([\s\S]*)$/);
    return m ? [m[1], m[2]] : [null, text];
  }

  // Reads every row at exactly `indent` (and their children) as one collection.
  // Which KIND of collection is decided by the first row, and a later row of
  // the other kind at the same indent is an error rather than a silent choice.
  function parseBlock(indent) {
    const isSequence = rows[pos].text.startsWith('- ') || rows[pos].text === '-';
    return isSequence ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent) {
    const out = {};
    const seen = new Set();
    while (pos < rows.length && rows[pos].indent === indent) {
      const row = rows[pos];
      if (row.text.startsWith('- ')) {
        throw new YamlError('a sequence item where a "key: value" was expected', row.lineNo);
      }
      const m = row.text.match(/^([^:]+?)\s*:(?:\s+(.*))?$/);
      if (!m) throw new YamlError(`expected "key: value", found ${JSON.stringify(row.text)}`, row.lineNo);
      const key = parseScalar(m[1], row.lineNo);
      // A repeated key is not a duplicate entry but a silently discarded one -
      // the last wins and the earlier is lost without a word. In a file whose
      // whole purpose is to declare what gets deployed, that is a change the
      // author did not make and cannot see.
      if (seen.has(key)) throw new YamlError(`duplicate key ${JSON.stringify(String(key))}`, row.lineNo);
      seen.add(key);
      pos++;

      const [anchor, inline] = takeAnchor(m[2] === undefined ? '' : m[2]);
      let value;
      if (inline !== '') {
        value = resolveInline(inline, row.lineNo);
      } else if (pos < rows.length && rows[pos].indent > indent) {
        value = parseBlock(rows[pos].indent);
      } else {
        value = null;
      }
      if (anchor) anchors.set(anchor, value);

      // "<<: *base" merges the aliased mapping in rather than storing it under
      // the literal key "<<". Keys already written win, as YAML specifies.
      if (key === '<<') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new YamlError('<< must merge a mapping', row.lineNo);
        }
        for (const [k, v] of Object.entries(value)) {
          if (!(k in out)) out[k] = v;
        }
        seen.delete('<<');
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  function parseSequence(indent) {
    const out = [];
    while (pos < rows.length && rows[pos].indent === indent) {
      const row = rows[pos];
      if (!row.text.startsWith('- ') && row.text !== '-') {
        throw new YamlError('a "key: value" where a sequence item was expected', row.lineNo);
      }
      const [seqAnchor, inline] = takeAnchor(row.text === '-' ? '' : row.text.slice(2).trim());
      pos++;

      if (inline === '') {
        const nested = (pos < rows.length && rows[pos].indent > indent) ? parseBlock(rows[pos].indent) : null;
        if (seqAnchor) anchors.set(seqAnchor, nested);
        out.push(nested);
        continue;
      }

      // "- key: value" opens a mapping whose remaining keys are indented to
      // where that key starts, two columns past the dash.
      if (/^[^:'"\[{]+:(\s|$)/.test(inline)) {
        const childIndent = indent + 2;
        rows.splice(pos, 0, { indent: childIndent, text: inline, lineNo: row.lineNo });
        const mapped = parseMapping(childIndent);
        if (seqAnchor) anchors.set(seqAnchor, mapped);
        out.push(mapped);
        continue;
      }

      const scalar = resolveInline(inline, row.lineNo);
      if (seqAnchor) anchors.set(seqAnchor, scalar);
      out.push(scalar);
    }
    return out;
  }

  if (rows.length === 0) return {};
  const result = parseBlock(rows[0].indent);
  if (pos < rows.length) {
    throw new YamlError(`unexpected indentation - expected ${rows[0].indent} spaces`, rows[pos].lineNo);
  }
  return result;
}

module.exports = { parse, YamlError };
