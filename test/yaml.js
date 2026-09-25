// Checks for the flarops.yaml reader.
//
// Every case here is a shape a person or an agent actually writes. The file is
// the one piece of generated output that gets hand-edited, so the reader's job
// is to agree with any other YAML tool on what it accepts, and to refuse the
// rest with a line number rather than returning something plausible.

const { parse, YamlError } = require('../utils/yamlLite');

const CASES = [
  ['nested mappings', 'a:\n  b:\n    c: 1\n', { a: { b: { c: 1 } } }],
  ['scalar types', 'a: 1\nb: true\nc: null\nd: ~\ne: 1.5\nf: text\n',
    { a: 1, b: true, c: null, d: null, e: 1.5, f: 'text' }],
  ['quoted scalars keep their text', 'a: "1"\nb: \'true\'\nc: "a: b"\n', { a: '1', b: 'true', c: 'a: b' }],
  ['sequences of scalars', 'ports:\n  - 80\n  - 443\n', { ports: [80, 443] }],
  ['sequences of mappings', 'v:\n  - name: a\n    path: /x\n  - name: b\n    path: /y\n',
    { v: [{ name: 'a', path: '/x' }, { name: 'b', path: '/y' }] }],
  ['comments and blank lines', '# top\na: 1\n\n  # indented comment\nb: 2\n', { a: 1, b: 2 }],
  ['a trailing comment is not part of the value', 'a: text # why\n', { a: 'text' }],
  ['a # inside quotes is', 'a: "c#1"\n', { a: 'c#1' }],

  // Flow collections: what an agent writes without thinking about it, and what
  // every docker-compose file is full of.
  ['flow sequence', 'command: ["node", "server.js"]\n', { command: ['node', 'server.js'] }],
  ['empty flow sequence', 'a: []\n', { a: [] }],
  ['flow mapping', 'a: {x: 1, y: two}\n', { a: { x: 1, y: 'two' } }],
  ['a comma inside quotes does not split', 'a: ["x,y", "z"]\n', { a: ['x,y', 'z'] }],

  // Anchors. Before these were supported, "env: *shared" with nothing indented
  // under it parsed as the STRING "*shared" and produced one environment
  // variable per character of it.
  ['an anchor on a block, reused by an alias',
    'a:\n  env: &shared\n    X: "1"\nb:\n  env: *shared\n',
    { a: { env: { X: '1' } }, b: { env: { X: '1' } } }],
  ['an anchor on a scalar', 'a: &n 5\nb: *n\n', { a: 5, b: 5 }],
  ['a merge key folds the aliased mapping in',
    'base: &b\n  X: "1"\n  Y: "2"\nsvc:\n  <<: *b\n  Y: "overridden"\n',
    { base: { X: '1', Y: '2' }, svc: { X: '1', Y: 'overridden' } }],
];

const REFUSALS = [
  ['a duplicate key', 'a: 1\na: 2\n', /duplicate key/],
  ['an undefined alias', 'a: *missing\n', /has not been defined/],
  ['a tab', 'a:\n\tb: 1\n', /tab/],
  ['an unterminated quote', 'a: "open\n', /unterminated/],
  ['an unclosed flow collection', 'a: [1, 2\n', /flow|expected/],
  ['a block scalar', 'a: |\n  text\n', /block scalar/],
  ['multiple documents', 'a: 1\n---\nb: 2\n', /multiple documents/],
];

function run(check) {
  for (const [name, text, expected] of CASES) {
    let got, error = null;
    try { got = parse(text); } catch (e) { error = e; }
    check(`reads ${name}`, !error && JSON.stringify(got) === JSON.stringify(expected),
      error ? error.message : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(expected)}`);
  }

  for (const [name, text, pattern] of REFUSALS) {
    let error = null;
    try { parse(text); } catch (e) { error = e; }
    check(`refuses ${name}`, error instanceof YamlError && pattern.test(error.message),
      error ? error.message : 'no error was raised');
    // A refusal nobody can act on is barely better than a wrong answer.
    if (error instanceof YamlError && !/multiple documents/.test(name)) {
      check(`the refusal of ${name} names a line`, /line \d+/.test(error.message), error.message);
    }
  }
}

module.exports = { run };
