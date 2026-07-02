'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { parse } = require('@babel/parser');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-extra-compressor-'));
const inputFile = path.join(tempDir, 'input.js');
const outputFile = path.join(tempDir, 'output.js');
const reportFile = path.join(tempDir, 'report.json');

const longArray = [
  'VERSION', 'SHADING_LANGUAGE_VERSION', 'MAX_VERTEX_ATTRIBS',
  'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_VARYING_VECTORS', 'ALIASED_LINE_WIDTH_RANGE',
  'ALIASED_POINT_SIZE_RANGE', 'MAX_FRAGMENT_UNIFORM_VECTORS',
  'MAX_TEXTURE_IMAGE_UNITS', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS'
];

const source = `
(function () {
  const proto = { inherited: 7 };
  const special = { __proto__: proto, own: 3 };
  const names = ${JSON.stringify(longArray)};
  class Example {
    componentDidMount() { return 'default'; }
    componentWillUnmount() { return 'default'; }
    render() { return Object.defineProperty({ render: 'default' }, '__esModule', { value: true }); }
  }
  const instances = [new Example(), new Example(), new Example(), new Example()];
  const words = ['default','default','default','default','default','default'];
  const result = instances.map(x => x.render().render).includes('default');
  globalThis.__optimizerResult = {
    names,
    result,
    words,
    inherited: special.inherited,
    own: special.own,
    protoIsCorrect: Object.getPrototypeOf(special) === proto,
    objectKeys: Object.keys(special),
    objectValues: Object.values({ a: 1, b: 2 }),
    objectNames: Object.getOwnPropertyNames(special)
  };
})();
`;

fs.writeFileSync(inputFile, source);
execFileSync(process.execPath, [
  path.join(__dirname, 'extra-compress.js'),
  inputFile,
  outputFile,
  '--min-occurrences', '3',
  '--min-saving', '0',
  '--array-min-items', '6',
  '--report', reportFile
], { stdio: 'inherit' });

const output = fs.readFileSync(outputFile, 'utf8');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

function execute(code) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { timeout: 2000 });
  return JSON.parse(JSON.stringify(sandbox.__optimizerResult));
}

assert.deepEqual(execute(output), execute(source));
assert.ok(report.stringArrays.length >= 1, 'expected at least one compacted string array');
assert.ok(report.aliases.some((entry) => entry.value === 'default'));
assert.ok(report.aliases.some((entry) => entry.value === 'Object'));
assert.ok(Buffer.byteLength(output) < Buffer.byteLength(source));

const ast = parse(output, { sourceType: 'script' });
assert.ok(!ast.program.body.some((node) => node.type === 'VariableDeclaration'),
  'optimizer must not add a program/global variable declaration');

console.log('All tests passed.');
