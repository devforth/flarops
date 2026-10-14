// Checks for the flarops.yaml reader.

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

  ['flow sequence', 'command: ["node", "server.js"]\n', { command: ['node', 'server.js'] }],
  ['empty flow sequence', 'a: []\n', { a: [] }],
  ['flow mapping', 'a: {x: 1, y: two}\n', { a: { x: 1, y: 'two' } }],
  ['a comma inside quotes does not split', 'a: ["x,y", "z"]\n', { a: ['x,y', 'z'] }],

  ['an anchor on a block, reused by an alias',
    'a:\n  env: &shared\n    X: "1"\nb:\n  env: *shared\n',
    { a: { env: { X: '1' } }, b: { env: { X: '1' } } }],
  ['an anchor on a scalar', 'a: &n 5\nb: *n\n', { a: 5, b: 5 }],
  ['unicode and hex escapes', 'a: "\\u0041\\x42\\t"\n', { a: 'AB\t' }],
  ['a byte-order mark and CRLF line endings', '\uFEFFa: 1\r\nb: 2\r\n', { a: 1, b: 2 }],
  ['a merge key folds the aliased mapping in',
    'base: &b\n  X: "1"\n  Y: "2"\nsvc:\n  <<: *b\n  Y: "overridden"\n',
    { base: { X: '1', Y: '2' }, svc: { X: '1', Y: 'overridden' } }],

  ['a number that would not read back keeps its text',
    'GUILD_ID: 812345678901234567\nAPP_VERSION: 1.10\nCODE: 007\nHALF: .5\nNEG: -0\n',
    { GUILD_ID: '812345678901234567', APP_VERSION: '1.10', CODE: '007', HALF: '.5', NEG: '-0' }],
  ['ports and replicas stay numbers', 'replicas: 3\nports:\n  - 4000\n  - 65535\nratio: 1.5\nn: -2\n',
    { replicas: 3, ports: [4000, 65535], ratio: 1.5, n: -2 }],
  ['an apostrophe inside a value is text, and the comment after it goes',
    "TITLE: Bob's app   # comment\nB: 'it''s'  # c\nC: 'a '' # b'\nD: [Bob's, 'x y']\n",
    { TITLE: "Bob's app", B: "it's", C: "a ' # b", D: ["Bob's", 'x y'] }],
  ['a sequence at its key\'s own indent',
    'api:\n  ports:\n  - 4000\n  - 80\n  volumes:\n  - name: a\n    path: /x\n  replicas: 2\nlist:\n- a\n- b\n',
    { api: { ports: [4000, 80], volumes: [{ name: 'a', path: '/x' }], replicas: 2 }, list: ['a', 'b'] }],
];

const REFUSALS = [
  ['a duplicate key', 'a: 1\na: 2\n', /duplicate key/],
  ['an undefined alias', 'a: *missing\n', /has not been defined/],
  ['a tab', 'a:\n\tb: 1\n', /tab/],
  ['an unterminated quote', 'a: "open\n', /unterminated/],
  ['an unclosed flow collection', 'a: [1, 2\n', /flow|expected/],
  ['a block scalar', 'a: |\n  text\n', /block scalar/],
  ['multiple documents', 'a: 1\n---\nb: 2\n', /multiple documents/],
  ['a tag', 'a: !!str 80\n', /tags such as/],
  ['an unknown escape', 'a: "x\\qy"\n', /unsupported escape/],
  ['a list inside a list item', 'a:\n  - - b\n', /list inside a list item/],
  ['aliases that expand without bound', (() => {
    let t = 'l0: &l0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]\n';
    for (let i = 1; i < 9; i++) t += `l${i}: &l${i} [${Array(10).fill('*l' + (i - 1)).join(', ')}]\n`;
    return t;
  })(), /too many values/],
];

// Where sync points an error: the line of a field path, items of a sequence included.
const LINES_TEXT = [
  'api:', //                       1
  '  ports:', //                   2
  '    - 4000', //                 3
  '    - 0', //                    4
  '  volumes:', //                 5
  '    - name: a', //              6
  '      path: /a', //             7
  '    - name: b', //              8
  '      path: x', //              9
  'worker:', //                    10
  '  ports:', //                   11
  '  - 80', //                     12
  '  - 99999', //                  13
  '  env:', //                     14
  '    A: "1"', //                 15
].join('\n');
const LINES = [
  ['api.ports[1]', 4],
  ['api.volumes[1].path', 9],
  ['api.volumes[1]', 8],
  ['api.volumes[0].name', 6],
  ['worker.ports[1]', 13],
  ['worker.env.A', 15],
  ['worker.ports[7]', 11],
];

function run(check) {
  const { lineOf } = require('../bin/commands/sync.js');
  for (const [where, line] of LINES) {
    const got = lineOf(LINES_TEXT, where);
    check(`an error at ${where} names line ${line}`, got === line, `got ${got}`);
  }

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
    if (error instanceof YamlError && !/multiple documents/.test(name)) {
      check(`the refusal of ${name} names a line`, /line \d+/.test(error.message), error.message);
    }
  }
}

module.exports = { run };
