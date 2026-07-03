'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

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

function escapeForRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findVariableInitType(ast, name) {
  let initType = null;
  traverse(ast, {
    VariableDeclarator(declaratorPath) {
      if (!t.isIdentifier(declaratorPath.node.id, { name })) return;
      initType = declaratorPath.node.init ? declaratorPath.node.init.type : null;
    }
  });
  return initType;
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

const undefinedAliasNames = undefinedReport.aliases
  .filter((entry) => entry.type === 'undefined')
  .map((entry) => entry.alias);
const undefinedAst = parse(undefinedOutput, { sourceType: 'script' });
let undefinedAliasWithVoidInit = false;
traverse(undefinedAst, {
  VariableDeclaration(declarationPath) {
    if (declarationPath.node.kind !== 'const') return;
    for (const declarator of declarationPath.node.declarations) {
      if (!t.isIdentifier(declarator.id)) continue;
      if (!undefinedAliasNames.includes(declarator.id.name)) continue;
      if (!t.isUnaryExpression(declarator.init, { operator: 'void' })) continue;
      if (!t.isNumericLiteral(declarator.init.argument, { value: 0 })) continue;
      undefinedAliasWithVoidInit = true;
    }
  }
});
assert.ok(undefinedAliasWithVoidInit,
  'expected undefined alias declarations to keep explicit = void 0 initializer');

const instanceofSource = `
(function(){
  function Parent() {}
  class Child extends Parent {}
  class Other {}
  const values = [new Child(), new Child(), new Other()];
  const checks = [
    values[0] instanceof Parent,
    values[1] instanceof Child,
    values[2] instanceof Parent,
    values[2] instanceof Other
  ];
  globalThis.__optimizerResult = { checks };
})();
`;
const instanceofInputFile = path.join(tempDir, 'instanceof-input.js');
const instanceofOutputFile = path.join(tempDir, 'instanceof-output.js');
const instanceofReportFile = path.join(tempDir, 'instanceof-report.json');
const instanceofOutputDisabledFile = path.join(tempDir, 'instanceof-output-disabled.js');
const instanceofReportDisabledFile = path.join(tempDir, 'instanceof-report-disabled.json');

fs.writeFileSync(instanceofInputFile, instanceofSource);
execFileSync(process.execPath, [
  cliPath,
  instanceofInputFile,
  instanceofOutputFile,
  '--instanceof-helper',
  '--no-string-arrays',
  '--no-object-unpacking',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--report', instanceofReportFile
], { stdio: 'inherit' });

execFileSync(process.execPath, [
  cliPath,
  instanceofInputFile,
  instanceofOutputDisabledFile,
  '--no-string-arrays',
  '--no-object-unpacking',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--report', instanceofReportDisabledFile
], { stdio: 'inherit' });

const instanceofOutput = fs.readFileSync(instanceofOutputFile, 'utf8');
const instanceofReport = JSON.parse(fs.readFileSync(instanceofReportFile, 'utf8'));
const instanceofOutputDisabled = fs.readFileSync(instanceofOutputDisabledFile, 'utf8');
const instanceofReportDisabled = JSON.parse(fs.readFileSync(instanceofReportDisabledFile, 'utf8'));

assert.deepEqual(execute(instanceofOutput), execute(instanceofSource));
assert.deepEqual(execute(instanceofOutputDisabled), execute(instanceofSource));
assert.equal(instanceofReport.options.instanceofHelper, true,
  'expected --instanceof-helper to enable instanceof helper rewrites');
assert.equal(instanceofReportDisabled.options.instanceofHelper, false,
  'expected instanceof helper rewrites to be disabled by default');

assert.equal(instanceofReport.instanceofSummary.candidates, 4,
  'expected all instanceof expressions to be detected for helper rewrite');
assert.equal(instanceofReport.instanceofSummary.rewritten, 4,
  'expected all instanceof expressions to be rewritten to helper calls');
assert.equal(instanceofReport.instanceofSummary.helpersInserted, 1,
  'expected one helper declaration per top-level function scope');

const instanceofHelperName = instanceofReport.instanceofHelpers[0]?.helper;
assert.ok(typeof instanceofHelperName === 'string' && instanceofHelperName.length > 0,
  'expected report to include a collision-safe helper name for instanceof rewrites');
assert.match(instanceofOutput,
  new RegExp(`const\\s+${escapeForRegExp(instanceofHelperName)}=\\(v,C\\)=>v\\s+instanceof\\s+C;`),
  'expected helper declaration to match (v, C) => v instanceof C form');

const instanceofAst = parse(instanceofOutput, { sourceType: 'script' });
let helperCallCount = 0;
let instanceofOperatorCount = 0;
traverse(instanceofAst, {
  CallExpression(callPath) {
    if (t.isIdentifier(callPath.node.callee, { name: instanceofHelperName })) helperCallCount += 1;
  },
  BinaryExpression(binaryPath) {
    if (binaryPath.node.operator === 'instanceof') instanceofOperatorCount += 1;
  }
});
assert.equal(helperCallCount, 4,
  'expected each instanceof expression to become a helper call');
assert.equal(instanceofOperatorCount, 1,
  'expected only helper body to retain instanceof operator');

assert.equal(instanceofReportDisabled.instanceofSummary.rewritten, 0,
  'expected default-disabled mode to skip helper rewrites');
assert.equal(instanceofReportDisabled.instanceofSummary.helpersInserted, 0,
  'expected default-disabled mode to avoid helper declaration insertion');
assert.ok(!new RegExp(`const\\s+${escapeForRegExp(instanceofHelperName)}=\\(v,C\\)=>v\\s+instanceof\\s+C;`)
  .test(instanceofOutputDisabled),
  'expected disabled mode to keep original instanceof expressions without helper declaration');

const instanceofDisabledAst = parse(instanceofOutputDisabled, { sourceType: 'script' });
let disabledInstanceofOperatorCount = 0;
traverse(instanceofDisabledAst, {
  BinaryExpression(binaryPath) {
    if (binaryPath.node.operator === 'instanceof') disabledInstanceofOperatorCount += 1;
  }
});
assert.equal(disabledInstanceofOperatorCount, 4,
  'expected disabled mode to preserve original instanceof operators');

const arrowSource = `
(function(){
  const add = function(a, b) { return a + b; };
  const square = function(value) { return value * value; };
  const make = function(value) { this.value = value; };
  const dynamic = function() { return this && this.kind; };
  const plain = function(v) { return add(v, 1); };
  globalThis.__optimizerResult = {
    add: add(2, 3),
    square: square(4),
    constructed: new make(9).value,
    dynamic: dynamic.call({ kind: 'ok' }),
    plain: plain(6)
  };
})();
`;
const arrowInputFile = path.join(tempDir, 'arrow-input.js');
const arrowOutputFile = path.join(tempDir, 'arrow-output.js');
const arrowReportFile = path.join(tempDir, 'arrow-report.json');
const arrowOutputDisabledFile = path.join(tempDir, 'arrow-output-disabled.js');
const arrowReportDisabledFile = path.join(tempDir, 'arrow-report-disabled.json');

fs.writeFileSync(arrowInputFile, arrowSource);
execFileSync(process.execPath, [
  cliPath,
  arrowInputFile,
  arrowOutputFile,
  '--arrow-functions',
  '--no-string-arrays',
  '--no-instanceof-helper',
  '--no-object-unpacking',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--min-occurrences', '99',
  '--report', arrowReportFile
], { stdio: 'inherit' });

execFileSync(process.execPath, [
  cliPath,
  arrowInputFile,
  arrowOutputDisabledFile,
  '--no-string-arrays',
  '--no-instanceof-helper',
  '--no-object-unpacking',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--min-occurrences', '99',
  '--report', arrowReportDisabledFile
], { stdio: 'inherit' });

const arrowOutput = fs.readFileSync(arrowOutputFile, 'utf8');
const arrowOutputDisabled = fs.readFileSync(arrowOutputDisabledFile, 'utf8');
const arrowReport = JSON.parse(fs.readFileSync(arrowReportFile, 'utf8'));
const arrowReportDisabled = JSON.parse(fs.readFileSync(arrowReportDisabledFile, 'utf8'));

assert.deepEqual(execute(arrowOutput), execute(arrowSource));
assert.deepEqual(execute(arrowOutputDisabled), execute(arrowSource));
assert.equal(arrowReport.options.arrowFunctions, true,
  'expected --arrow-functions to enable arrow-function rewrites');
assert.equal(arrowReportDisabled.options.arrowFunctions, false,
  'expected arrow-function rewrites to be disabled by default');
assert.ok(arrowReport.arrowSummary.candidates >= 3,
  'expected multiple function expressions to be considered for arrow rewrite');
assert.ok(arrowReport.arrowSummary.rewritten >= 3,
  'expected arrow rewrite pass to convert call-only function-expression bindings');
assert.equal(arrowReportDisabled.arrowSummary.rewritten, 0,
  'expected disabled mode to skip arrow rewrites');

const arrowAst = parse(arrowOutput, { sourceType: 'script' });
const arrowDisabledAst = parse(arrowOutputDisabled, { sourceType: 'script' });

assert.equal(findVariableInitType(arrowAst, 'add'), 'ArrowFunctionExpression',
  'expected add() function expression to be rewritten to arrow form');
assert.equal(findVariableInitType(arrowAst, 'square'), 'ArrowFunctionExpression',
  'expected square() function expression to be rewritten to arrow form');
assert.equal(findVariableInitType(arrowAst, 'plain'), 'ArrowFunctionExpression',
  'expected plain() function expression to be rewritten to arrow form');
assert.equal(findVariableInitType(arrowAst, 'make'), 'FunctionExpression',
  'expected constructor-used function to remain a normal function expression');
assert.equal(findVariableInitType(arrowAst, 'dynamic'), 'FunctionExpression',
  'expected this-sensitive function to remain a normal function expression');
assert.equal(findVariableInitType(arrowDisabledAst, 'add'), 'FunctionExpression',
  'expected disabled mode output to preserve function expressions');

const strictSource = `
(function(){
  "use strict";
  function first(value) {
    "use strict";
    return value + 1;
  }
  function second(value) {
    "use strict";
    return first(value) + 1;
  }
  globalThis.__optimizerResult = { value: second(3) };
})();
`;
const strictInputFile = path.join(tempDir, 'strict-input.js');
const strictOutputFile = path.join(tempDir, 'strict-output.js');
const strictReportFile = path.join(tempDir, 'strict-report.json');
const strictOutputNoAssumeFile = path.join(tempDir, 'strict-output-no-assume.js');
const strictReportNoAssumeFile = path.join(tempDir, 'strict-report-no-assume.json');

fs.writeFileSync(strictInputFile, strictSource);
execFileSync(process.execPath, [
  cliPath,
  strictInputFile,
  strictOutputFile,
  '--assume-strict',
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--report', strictReportFile
], { stdio: 'inherit' });

execFileSync(process.execPath, [
  cliPath,
  strictInputFile,
  strictOutputNoAssumeFile,
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--report', strictReportNoAssumeFile
], { stdio: 'inherit' });

const strictOutput = fs.readFileSync(strictOutputFile, 'utf8');
const strictOutputNoAssume = fs.readFileSync(strictOutputNoAssumeFile, 'utf8');
const strictReport = JSON.parse(fs.readFileSync(strictReportFile, 'utf8'));
const strictReportNoAssume = JSON.parse(fs.readFileSync(strictReportNoAssumeFile, 'utf8'));

assert.deepEqual(execute(strictOutput), execute(strictSource));
assert.deepEqual(execute(strictOutputNoAssume), execute(strictSource));
const strictCount = (strictOutput.match(/(["'])use strict\1/g) || []).length;
const strictCountNoAssume = (strictOutputNoAssume.match(/(["'])use strict\1/g) || []).length;
assert.equal(strictCount, 1,
  'expected --assume-strict to keep exactly one use strict directive in output');
assert.ok(strictCountNoAssume > 1,
  'expected output without --assume-strict to keep multiple use strict directives');
const strictAst = parse(strictOutput, { sourceType: 'script' });
assert.equal(strictAst.program.directives[0]?.value?.value, 'use strict',
  'expected remaining use strict directive to be at top level');
assert.equal(strictReport.strictNormalization.enabled, true);
assert.equal(strictReport.strictNormalization.inserted, 1);
assert.ok(strictReport.strictNormalization.removed >= 2,
  'expected assume-strict pass to remove nested strict directives');
assert.equal(strictReportNoAssume.strictNormalization.enabled, false);

const objectUnpackSource = `
(function(){
  const o = [{index:7,amount:15},{index:6,amount:25},{index:5,amount:30},{index:5,amount:45}];
  globalThis.__optimizerResult = { o };
})();
`;
const objectUnpackInputFile = path.join(tempDir, 'object-unpack-input.js');
const objectUnpackOutputFile = path.join(tempDir, 'object-unpack-output.js');
const objectUnpackReportFile = path.join(tempDir, 'object-unpack-report.json');
const objectUnpackOutputDisabledFile = path.join(tempDir, 'object-unpack-output-disabled.js');
const objectUnpackReportDisabledFile = path.join(tempDir, 'object-unpack-report-disabled.json');

fs.writeFileSync(objectUnpackInputFile, objectUnpackSource);
execFileSync(process.execPath, [
  cliPath,
  objectUnpackInputFile,
  objectUnpackOutputFile,
  '--object-unpacking',
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--report', objectUnpackReportFile
], { stdio: 'inherit' });

execFileSync(process.execPath, [
  cliPath,
  objectUnpackInputFile,
  objectUnpackOutputDisabledFile,
  '--no-object-unpacking',
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-strings',
  '--no-alias-undefined',
  '--report', objectUnpackReportDisabledFile
], { stdio: 'inherit' });

const objectUnpackOutput = fs.readFileSync(objectUnpackOutputFile, 'utf8');
const objectUnpackOutputDisabled = fs.readFileSync(objectUnpackOutputDisabledFile, 'utf8');
const objectUnpackReport = JSON.parse(fs.readFileSync(objectUnpackReportFile, 'utf8'));
const objectUnpackReportDisabled = JSON.parse(fs.readFileSync(objectUnpackReportDisabledFile, 'utf8'));

assert.deepEqual(execute(objectUnpackOutput), execute(objectUnpackSource));
assert.deepEqual(execute(objectUnpackOutputDisabled), execute(objectUnpackSource));
assert.ok(objectUnpackReport.objectUnpackSummary.candidates >= 1,
  'expected repeated-key object arrays to be detected');
assert.ok(objectUnpackReport.objectUnpackSummary.rewritten >= 1,
  'expected object-array unpacking helper rewrite to be applied');
const objectUnpackHelperName = objectUnpackReport.objectUnpacks[0]?.helper;
assert.ok(typeof objectUnpackHelperName === 'string' && objectUnpackHelperName.length > 0,
  'expected transformed output report to include unpacking helper variable name');
assert.ok(objectUnpackOutput.includes(`const ${objectUnpackHelperName}=`),
  'expected transformed output to include unpacking helper declaration');

const objectUnpackAst = parse(objectUnpackOutput, { sourceType: 'script' });
let unpackingCallHasFlatPayload = false;
traverse(objectUnpackAst, {
  CallExpression(callPath) {
    if (!t.isIdentifier(callPath.node.callee)) return;
    if (callPath.node.callee.name !== objectUnpackHelperName) return;
    if (!callPath.node.arguments.length) return;
    const [firstArg] = callPath.node.arguments;
    if (!t.isArrayExpression(firstArg)) return;
    if (!firstArg.elements.every((element) => !t.isArrayExpression(element))) return;
    unpackingCallHasFlatPayload = true;
  }
});
assert.ok(unpackingCallHasFlatPayload,
  'expected object unpacking helper call to use a flat values payload array');

assert.equal(objectUnpackReportDisabled.objectUnpackSummary.rewritten, 0,
  'expected --no-object-unpacking to disable helper rewrites');
assert.ok(!objectUnpackOutputDisabled.includes(`const ${objectUnpackHelperName}=`),
  'expected no helper declaration when object-array unpacking is disabled');

const transformedAliasSource = `
(function(){
  const rows = [
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" },
    { kind: "default", label: "default" }
  ];
  globalThis.__optimizerResult = { rows };
})();
`;
const transformedAliasInputFile = path.join(tempDir, 'transformed-alias-input.js');
const transformedAliasOutputFile = path.join(tempDir, 'transformed-alias-output.js');
const transformedAliasReportFile = path.join(tempDir, 'transformed-alias-report.json');

fs.writeFileSync(transformedAliasInputFile, transformedAliasSource);
execFileSync(process.execPath, [
  cliPath,
  transformedAliasInputFile,
  transformedAliasOutputFile,
  '--object-unpacking',
  '--no-string-arrays',
  '--no-alias-globals',
  '--no-alias-properties',
  '--no-alias-undefined',
  '--min-occurrences', '2',
  '--min-saving', '0',
  '--report', transformedAliasReportFile
], { stdio: 'inherit' });

const transformedAliasOutput = fs.readFileSync(transformedAliasOutputFile, 'utf8');
const transformedAliasReport = JSON.parse(fs.readFileSync(transformedAliasReportFile, 'utf8'));

assert.deepEqual(execute(transformedAliasOutput), execute(transformedAliasSource));
assert.ok(transformedAliasReport.objectUnpackSummary.rewritten >= 1,
  'expected object-array unpacking to rewrite transformed-alias fixture');
assert.ok(transformedAliasReport.aliases.some((entry) => entry.value === 'default' && entry.type === 'string'),
  'expected alias collection to include repeated strings introduced by earlier transforms');

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
