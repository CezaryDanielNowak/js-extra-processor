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
assert.equal(report.webpackModuleExtraction.detected, false,
  'non-webpack fixtures should not report webpack module extraction candidates');
assert.ok(Buffer.byteLength(output) < Buffer.byteLength(source));

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

const webpackSource = `
(function () {
  return (() => {
    var __webpack_modules__ = {
      1: function (module, __webpack_exports__, __webpack_require__) {
        'use strict';
        __webpack_require__.r(__webpack_exports__);
        __webpack_require__.d(__webpack_exports__, { default: () => localDefault });
        const localDefault = function () { return 1; };
      },
      2: function (module, __webpack_exports__, __webpack_require__) {
        'use strict';
        __webpack_require__.r(__webpack_exports__);
        var dep = __webpack_require__(1);
        __webpack_require__.d(__webpack_exports__, { default: () => dep.default });
      }
    };
    var __webpack_module_cache__ = {};
    function __webpack_require__(id) {
      var cached = __webpack_module_cache__[id];
      if (cached !== undefined) return cached.exports;
      var module = __webpack_module_cache__[id] = { exports: {} };
      __webpack_modules__[id](module, module.exports, __webpack_require__);
      return module.exports;
    }
    __webpack_require__.d = function (exports, definition) {
      for (var key in definition) {
        if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
          Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
        }
      }
    };
    __webpack_require__.o = function (obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); };
    __webpack_require__.r = function (exports) {
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      }
      Object.defineProperty(exports, '__esModule', { value: true });
    };
    var __webpack_exports__ = __webpack_require__(2);
    globalThis.__optimizerResult = { value: __webpack_exports__.default() };
  })();
})();
`;
const webpackInputFile = path.join(tempDir, 'webpack-input.js');
const webpackOutputFile = path.join(tempDir, 'webpack-output.js');
const webpackReportFile = path.join(tempDir, 'webpack-report.json');

fs.writeFileSync(webpackInputFile, webpackSource);
execFileSync(process.execPath, [
  cliPath,
  webpackInputFile,
  webpackOutputFile,
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--report', webpackReportFile
], { stdio: 'inherit' });

const webpackOutput = fs.readFileSync(webpackOutputFile, 'utf8');
const webpackReport = JSON.parse(fs.readFileSync(webpackReportFile, 'utf8'));
assert.deepEqual(execute(webpackOutput), execute(webpackSource));
assert.equal(webpackReport.webpackModuleExtraction.detected, true,
  'webpack-like fixtures should enable extraction analysis');
assert.ok(webpackReport.webpackModuleExtraction.extractable.totalCandidates >= 1,
  'expected at least one extractable webpack module candidate');
assert.ok(webpackReport.webpackModuleExtraction.extractable.byType.defaultLocal >= 1,
  'expected at least one default-local extractable candidate');
assert.ok(webpackReport.webpackImportOptimization.attempted,
  'expected webpack import optimization to run when mappings are available');
assert.ok(webpackReport.webpackImportOptimization.rewrittenTotal >= 1,
  'expected at least one rewritten webpack import');
assert.match(webpackOutput, /__webpack_require__\(1\)/,
  'expected optimized output to reference the underlying dependency module id');

console.log('All tests passed.');
