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
const cliPath = path.join(__dirname, 'extra-compress.js');

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
  cliPath,
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
assert.equal(report.concatCompaction.attempted, false,
  'fixtures without concat opportunities should not attempt concat compaction');
assert.equal(report.concatCompaction.selected, false,
  'concat compaction should not be selected when no candidates exist');
assert.ok(Buffer.byteLength(output) < Buffer.byteLength(source));

const undefinedSource = `
(function(){
  const a = undefined;
  const b = void 0;
  const c = undefined;
  const d = void 0;
  const e = undefined;
  globalThis.__optimizerResult = {
    values: [a, b, c, d, e],
    checks: [a === b, c === d, typeof e]
  };
})();
`;
const undefinedInputFile = path.join(tempDir, 'undefined-input.js');
const undefinedOutputFile = path.join(tempDir, 'undefined-output.js');
const undefinedReportFile = path.join(tempDir, 'undefined-report.json');
const undefinedOutputNoAliasFile = path.join(tempDir, 'undefined-output-no-alias.js');
const undefinedReportNoAliasFile = path.join(tempDir, 'undefined-report-no-alias.json');

fs.writeFileSync(undefinedInputFile, undefinedSource);
execFileSync(process.execPath, [
  cliPath,
  undefinedInputFile,
  undefinedOutputFile,
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--report', undefinedReportFile
], { stdio: 'inherit' });

execFileSync(process.execPath, [
  cliPath,
  undefinedInputFile,
  undefinedOutputNoAliasFile,
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--report', undefinedReportNoAliasFile
], { stdio: 'inherit' });

const undefinedOutput = fs.readFileSync(undefinedOutputFile, 'utf8');
const undefinedOutputNoAlias = fs.readFileSync(undefinedOutputNoAliasFile, 'utf8');
const undefinedReport = JSON.parse(fs.readFileSync(undefinedReportFile, 'utf8'));
const undefinedReportNoAlias = JSON.parse(fs.readFileSync(undefinedReportNoAliasFile, 'utf8'));

assert.deepEqual(execute(undefinedOutput), execute(undefinedSource));
assert.deepEqual(execute(undefinedOutputNoAlias), execute(undefinedSource));
assert.ok(undefinedReport.aliases.some((entry) => entry.type === 'undefined'),
  'expected undefined/void 0 alias candidate to be selected');
assert.ok(!undefinedReportNoAlias.aliases.some((entry) => entry.type === 'undefined'),
  'expected --no-alias-undefined to disable undefined/void 0 aliasing');

const concatSource = `
(function(){
  const variable = 41;
  const extra = 2;
  const phrases = [
    "First " + variable + " and " + extra + ".",
    "First " + (variable + 1) + " and " + extra + ".",
    "First " + (variable + 2) + " and " + extra + "."
  ];
  globalThis.__optimizerResult = { phrases };
})();
`;
const concatInputFile = path.join(tempDir, 'concat-input.js');
const concatOutputFile = path.join(tempDir, 'concat-output.js');
const concatReportFile = path.join(tempDir, 'concat-report.json');

fs.writeFileSync(concatInputFile, concatSource);
execFileSync(process.execPath, [
  cliPath,
  concatInputFile,
  concatOutputFile,
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--report', concatReportFile
], { stdio: 'inherit' });

const concatOutput = fs.readFileSync(concatOutputFile, 'utf8');
const concatReport = JSON.parse(fs.readFileSync(concatReportFile, 'utf8'));
assert.deepEqual(execute(concatOutput), execute(concatSource));
assert.equal(concatReport.concatCompaction.attempted, true,
  'expected concat compaction guard to run on concat-heavy fixtures');
assert.equal(concatReport.concatCompaction.selected, true,
  'expected concat compaction guard to keep rewrites when compressed result is better');
assert.ok(concatReport.stringConcats.length >= 1,
  'expected at least one concatenation rewritten to template literal');
assert.equal(concatReport.concatCompaction.candidateCount, concatReport.stringConcats.length,
  'selected concat rewrites should match candidate count');
assert.ok(concatReport.stringConcats.every((entry) => entry.saving > 0),
  'all concatenation rewrites should have positive local raw-byte savings');
assert.ok(concatOutput.includes('`'),
  'expected optimized output to include a template literal');

const concatSkipSource = `
(function(){
  const variable = 7;
  const single = "Single " + variable;
  const withBacktick = "Tick \` " + variable + ".";
  globalThis.__optimizerResult = { single, withBacktick };
})();
`;
const concatSkipInputFile = path.join(tempDir, 'concat-skip-input.js');
const concatSkipOutputFile = path.join(tempDir, 'concat-skip-output.js');
const concatSkipReportFile = path.join(tempDir, 'concat-skip-report.json');

fs.writeFileSync(concatSkipInputFile, concatSkipSource);
execFileSync(process.execPath, [
  cliPath,
  concatSkipInputFile,
  concatSkipOutputFile,
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--report', concatSkipReportFile
], { stdio: 'inherit' });

const concatSkipOutput = fs.readFileSync(concatSkipOutputFile, 'utf8');
const concatSkipReport = JSON.parse(fs.readFileSync(concatSkipReportFile, 'utf8'));
assert.deepEqual(execute(concatSkipOutput), execute(concatSkipSource));
assert.equal(concatSkipReport.concatCompaction.attempted, false,
  'single-concat and backslash-increasing cases should not be considered candidates');
assert.equal(concatSkipReport.stringConcats.length, 0,
  'single-concat and backslash-increasing cases must remain unreplaced');

const ast = parse(output, { sourceType: 'script' });
assert.ok(!ast.program.body.some((node) => node.type === 'VariableDeclaration'),
  'optimizer must not add a program/global variable declaration');

const noGainSource = `(function(){const arr=["__esModule","default","default","ABC","componentDidMount","AA","LONGTOKEN","LONGTOKEN","AB"];const s=["AB","ABC","ABC","AB","ABC","LONGTOKEN","LONGTOKEN","__esModule"];globalThis.r=arr.join(',')+s.join(',');})();`;
const noGainInputFile = path.join(tempDir, 'no-gain-input.js');
const noGainOutputFile = path.join(tempDir, 'no-gain-output.js');
const noGainNoArraysOutputFile = path.join(tempDir, 'no-gain-output-no-arrays.js');
const noGainReportFile = path.join(tempDir, 'no-gain-report.json');

fs.writeFileSync(noGainInputFile, noGainSource);
execFileSync(process.execPath, [
  cliPath,
  noGainInputFile,
  noGainOutputFile,
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--array-min-items', '6',
  '--array-min-saving', '0',
  '--report', noGainReportFile
], { stdio: 'inherit' });
execFileSync(process.execPath, [
  cliPath,
  noGainInputFile,
  noGainNoArraysOutputFile,
  '--no-string-arrays',
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--array-min-items', '6',
  '--array-min-saving', '0'
], { stdio: 'inherit' });

const noGainOutput = fs.readFileSync(noGainOutputFile, 'utf8');
const noGainNoArraysOutput = fs.readFileSync(noGainNoArraysOutputFile, 'utf8');
const noGainReport = JSON.parse(fs.readFileSync(noGainReportFile, 'utf8'));
assert.equal(noGainOutput, noGainNoArraysOutput,
  'string-array mode should fall back to the no-array output when compaction inflates the bundle');
assert.equal(noGainReport.arrayCompaction.selected, false,
  'report should record when string-array compaction is skipped');
assert.ok(noGainReport.arrayCompaction.candidateCount >= 1,
  'expected at least one candidate array before skip decision');

let arrayMinItemsError = null;
try {
  execFileSync(process.execPath, [
    cliPath,
    inputFile,
    outputFile,
    '--array-min-items', '5'
  ], { stdio: 'pipe' });
} catch (error) {
  arrayMinItemsError = error;
}

assert.ok(arrayMinItemsError, 'expected --array-min-items < 6 to fail fast');
assert.match(String(arrayMinItemsError.stderr), /--array-min-items expects an integer >= 6/);

console.log('All tests passed.');
