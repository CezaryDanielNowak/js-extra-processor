#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { minify } = require('terser');

const SAFE_GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error',
  'EvalError', 'Float32Array', 'Float64Array', 'Function', 'Int8Array',
  'Int16Array', 'Int32Array', 'JSON', 'Map', 'Math', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp',
  'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
  'WeakMap', 'WeakSet'
]);

const DELIMITERS = [
  '!', '|', '~', '^', '@', '#', '%', '&', '*', ';', ':', ',', '?', '/', '+', '=', '-', '_', '.', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'
];

function usage(exitCode = 0) {
  const text = `
Usage:
  node extra-compress.js <input.js> [output.js] [options]

Options:
  --min-occurrences <n>   Minimum occurrences for an alias (default: 4)
  --min-saving <n>        Minimum estimated raw-byte saving per alias (default: 2)
  --max-aliases <n>       Maximum aliases per top-level function scope (default: 160)
  --array-min-items <n>   Minimum strings in an array before trying join/split (default: 6)
  --array-min-saving <n>  Minimum raw-byte saving for an array rewrite (default: 2)
  --arrow-functions       Enable function-expression to arrow rewrites (default: off; makes final bundle larger; TODO: investigate)
  --no-arrow-functions    Disable function-expression to arrow rewrites
  --instanceof-helper     Enable instanceof helper rewrite (default: off)
  --no-instanceof-helper  Disable instanceof helper rewrite
  --object-unpacking      Enable object-array unpacking helper transform (default: off)
  --no-object-unpacking   Disable object-array unpacking helper transform
  --assume-strict         Assume strict mode is safe and collapse repeated "use strict" directives
  --no-string-arrays      Disable string-array compaction
  --no-alias-globals      Do not alias safe built-ins such as Object or Array
  --no-alias-undefined    Do not alias undefined and void 0 values
  --no-alias-properties   Do not alias property/method names
  --no-alias-strings      Do not alias repeated string literals
  --no-terser-print       Use Babel's compact printer instead of Terser for final printing
  --report <file.json>    Write a JSON optimization report
  --help                  Show this help

The optimizer inserts aliases only inside existing top-level function scopes. It does
not add variables to the global scope. Program-level occurrences are intentionally
left untouched.
`;
  process.stderr.write(text.trimStart());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    minOccurrences: 4,
    minSaving: 2,
    maxAliases: 160,
    arrayMinItems: 6,
    arrayMinSaving: 2,
    arrowFunctions: false,
    instanceofHelper: false,
    objectUnpacking: false,
    assumeStrict: false,
    stringArrays: true,
    aliasGlobals: true,
    aliasUndefined: true,
    aliasProperties: true,
    aliasStrings: true,
    terserPrint: true,
    reportFile: null,
    positional: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts.positional.push(arg);
      continue;
    }
    if (arg === '--help') usage(0);
    if (arg === '--assume-strict') opts.assumeStrict = true;
    else if (arg === '--arrow-functions') opts.arrowFunctions = true;
    else if (arg === '--no-arrow-functions') opts.arrowFunctions = false;
    else if (arg === '--instanceof-helper') opts.instanceofHelper = true;
    else if (arg === '--no-instanceof-helper') opts.instanceofHelper = false;
    else if (arg === '--object-unpacking') opts.objectUnpacking = true;
    else if (arg === '--no-object-unpacking') opts.objectUnpacking = false;
    else if (arg === '--no-string-arrays') opts.stringArrays = false;
    else if (arg === '--no-alias-globals') opts.aliasGlobals = false;
    else if (arg === '--no-alias-undefined') opts.aliasUndefined = false;
    else if (arg === '--no-alias-properties') opts.aliasProperties = false;
    else if (arg === '--no-alias-strings') opts.aliasStrings = false;
    else if (arg === '--no-terser-print') opts.terserPrint = false;
    else if (arg === '--min-occurrences') opts.minOccurrences = readInt(argv, ++i, arg, 2);
    else if (arg === '--min-saving') opts.minSaving = readInt(argv, ++i, arg, 0);
    else if (arg === '--max-aliases') opts.maxAliases = readInt(argv, ++i, arg, 0);
    else if (arg === '--array-min-items') opts.arrayMinItems = readInt(argv, ++i, arg, 6);
    else if (arg === '--array-min-saving') opts.arrayMinSaving = readInt(argv, ++i, arg, 0);
    else if (arg === '--report') opts.reportFile = argv[++i] || usage(1);
    else usage(1);
  }

  if (opts.positional.length < 1 || opts.positional.length > 2) usage(1);
  opts.inputFile = path.resolve(opts.positional[0]);
  opts.outputFile = path.resolve(
    opts.positional[1] || opts.positional[0].replace(/(\.m?js|\.txt)?$/i, '.extra.min.js')
  );
  return opts;
}

function readInt(argv, index, flag, min) {
  const value = Number.parseInt(argv[index], 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${flag} expects an integer >= ${min}`);
  }
  return value;
}

function parseCode(code, filename) {
  return parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: filename,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    attachComment: true,
    plugins: [
      'asyncGenerators',
      'bigInt',
      'classPrivateMethods',
      'classPrivateProperties',
      'classProperties',
      'classStaticBlock',
      'dynamicImport',
      'exportDefaultFrom',
      'exportNamespaceFrom',
      'importAttributes',
      'importMeta',
      'logicalAssignment',
      'nullishCoalescingOperator',
      'numericSeparator',
      'objectRestSpread',
      'optionalCatchBinding',
      'optionalChaining',
      'privateIn',
      'topLevelAwait'
    ]
  });
}

function minifiedNode(node) {
  return generate(node, {
    comments: false,
    compact: true,
    minified: true,
    jsescOption: { minimal: true }
  }).code;
}

function codeByteLength(code) {
  return Buffer.byteLength(code);
}

function stringLiteralLength(value) {
  return codeByteLength(minifiedNode(t.stringLiteral(value)));
}

function byteStats(text) {
  const input = Buffer.from(text);
  return {
    raw: input.length,
    gzip: zlib.gzipSync(input, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(input, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  };
}

function getStaticObjectKeyName(keyNode) {
  if (t.isIdentifier(keyNode)) return keyNode.name;
  if (t.isStringLiteral(keyNode)) return keyNode.value;
  if (t.isNumericLiteral(keyNode)) return String(keyNode.value);
  return null;
}

function createUseStrictDirective() {
  return t.directive(t.directiveLiteral('use strict'));
}

function stripUseStrictFromDirectives(directives) {
  let removed = 0;

  for (let index = directives.length - 1; index >= 0; index -= 1) {
    const directive = directives[index];
    if (directive?.value?.value !== 'use strict') continue;
    directives.splice(index, 1);
    removed += 1;
  }

  return removed;
}

function normalizeStrictDirectives(ast, report) {
  let removed = 0;

  traverse(ast, {
    Program(programPath) {
      if (!programPath.node.directives) programPath.node.directives = [];
      removed += stripUseStrictFromDirectives(programPath.node.directives);
      programPath.node.directives.unshift(createUseStrictDirective());
    },

    Function(functionPath) {
      if (!t.isBlockStatement(functionPath.node.body)) return;
      if (!functionPath.node.body.directives) functionPath.node.body.directives = [];
      removed += stripUseStrictFromDirectives(functionPath.node.body.directives);
    }
  });

  report.strictNormalization.removed = removed;
  report.strictNormalization.inserted = 1;
}

function isDirectiveString(pathRef) {
  if (!pathRef.isStringLiteral()) return false;
  const parent = pathRef.parentPath;
  return parent && parent.isExpressionStatement() && typeof parent.node.directive === 'string';
}

function isKeyPosition(pathRef) {
  const parent = pathRef.parentPath;
  if (!parent) return false;
  if ((parent.isObjectProperty() || parent.isObjectMethod() || parent.isClassMethod() ||
       parent.isClassProperty() || parent.isClassAccessorProperty?.()) &&
      pathRef.key === 'key' && !parent.node.computed) return true;
  return false;
}

function isStaticModuleSpecifier(pathRef) {
  const parent = pathRef.parentPath;
  if (!parent) return false;
  return parent.isImportDeclaration() || parent.isExportNamedDeclaration() ||
    parent.isExportAllDeclaration() || parent.isImportExpression?.() ||
    (parent.isCallExpression() && parent.node.callee && parent.node.callee.type === 'Import');
}

function isInsideJsx(pathRef) {
  return Boolean(pathRef.findParent((p) => p.isJSXElement?.() || p.isJSXFragment?.()));
}

function getOutermostFunction(pathRef) {
  let cursor = pathRef;
  let outermost = null;
  while (cursor) {
    if (cursor.isFunction && cursor.isFunction()) outermost = cursor;
    cursor = cursor.parentPath;
  }
  return outermost;
}

function isInRootBody(pathRef, rootPath, allowOffsetless = true) {
  const body = rootPath.node.body;
  if (!body) return false;

  if (pathRef.node.start == null || body.start == null || pathRef.node.end == null || body.end == null) {
    if (!allowOffsetless) return false;

    let cursor = pathRef;
    while (cursor) {
      if (cursor.node === rootPath.node || cursor.node === body) return true;
      cursor = cursor.parentPath;
    }
    return false;
  }

  return pathRef.node.start >= body.start && pathRef.node.end <= body.end;
}

function getScopeRecord(scopeMap, rootPath) {
  let record = scopeMap.get(rootPath.node);
  if (!record) {
    record = {
      rootPath,
      candidates: new Map(),
      forbiddenGlobalWrites: null,
      aliases: []
    };
    scopeMap.set(rootPath.node, record);
  }
  return record;
}

function addOccurrence(record, key, initKind, value, occurrence) {
  let candidate = record.candidates.get(key);
  if (!candidate) {
    candidate = { key, initKind, value, occurrences: [] };
    record.candidates.set(key, candidate);
  }
  candidate.occurrences.push(occurrence);
}

function compactStringArrays(ast, opts, report) {
  if (!opts.stringArrays) return;

  traverse(ast, {
    ArrayExpression: {
      exit(arrayPath) {
        const elements = arrayPath.node.elements;
        if (elements.length < opts.arrayMinItems) return;
        if (!elements.every((element) => t.isStringLiteral(element))) return;

        const values = elements.map((element) => element.value);
        const delimiter = DELIMITERS.find((candidate) => values.every((value) => !value.includes(candidate)));
        if (!delimiter) return;

        const joined = values.join(delimiter);
        const replacement = t.callExpression(
          t.memberExpression(t.stringLiteral(joined), t.identifier('split')),
          [t.stringLiteral(delimiter)]
        );

        const location = arrayPath.node.loc?.start || null;
        const before = codeByteLength(minifiedNode(arrayPath.node));
        const after = codeByteLength(minifiedNode(replacement));
        const saving = before - after;
        if (saving < opts.arrayMinSaving) return;

        arrayPath.replaceWith(replacement);
        report.stringArrays.push({
          items: values.length,
          delimiter,
          before,
          after,
          saving,
          location
        });
      }
    }
  });
}

function flattenPlusChain(node) {
  const terms = [];
  let cursor = node;
  while (t.isBinaryExpression(cursor, { operator: '+' })) {
    terms.push(cursor.right);
    cursor = cursor.left;
  }
  terms.push(cursor);
  terms.reverse();
  return terms;
}

function countBackslashes(text) {
  return (text.match(/\\/g) || []).length;
}

function templateRawText(value) {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function buildTemplateLiteralFromConcat(terms) {
  if (!terms.length || !t.isStringLiteral(terms[0])) return null;

  let currentText = terms[0].value;
  const quasis = [];
  const expressions = [];

  for (let i = 1; i < terms.length; i += 1) {
    const term = terms[i];
    if (t.isStringLiteral(term)) {
      currentText += term.value;
      continue;
    }

    quasis.push(t.templateElement({
      raw: templateRawText(currentText),
      cooked: currentText
    }, false));
    expressions.push(t.cloneNode(term, true));
    currentText = '';
  }

  if (!expressions.length) return null;

  quasis.push(t.templateElement({
    raw: templateRawText(currentText),
    cooked: currentText
  }, true));
  return t.templateLiteral(quasis, expressions);
}

function optimizeStringConcats(ast, report, minSaving = 1) {
  traverse(ast, {
    BinaryExpression: {
      exit(binaryPath) {
        if (binaryPath.node.operator !== '+') return;

        const parent = binaryPath.parentPath;
        if (parent && parent.isBinaryExpression({ operator: '+' }) && parent.node.left === binaryPath.node) {
          return;
        }

          const terms = flattenPlusChain(binaryPath.node);
          if (terms.length <= 2) return;

        const replacement = buildTemplateLiteralFromConcat(terms);
        if (!replacement) return;
        if (replacement.expressions.length <= 1) return;

          const beforeCode = minifiedNode(binaryPath.node);
          const afterCode = minifiedNode(replacement);
          if (countBackslashes(afterCode) > countBackslashes(beforeCode)) return;

          const before = codeByteLength(beforeCode);
          const after = codeByteLength(afterCode);
        const saving = before - after;
        if (saving < minSaving) return;
        const location = binaryPath.node.loc?.start || null;

        binaryPath.replaceWith(replacement);
        report.stringConcats.push({
          terms: terms.length,
          before,
          after,
          saving,
          location
        });
      }
    }
  });
}

function hasDuplicateParamBindings(params) {
  const names = new Set();

  for (const param of params) {
    const bindings = Object.keys(t.getBindingIdentifiers(param));
    for (const bindingName of bindings) {
      if (names.has(bindingName)) return true;
      names.add(bindingName);
    }
  }

  return false;
}

function hasArrowUnsafeSemantics(functionPath) {
  let unsafe = false;

  functionPath.traverse({
    Function(innerPath) {
      if (innerPath === functionPath) return;
      if (!innerPath.isArrowFunctionExpression()) innerPath.skip();
    },

    ThisExpression(thisPath) {
      unsafe = true;
      thisPath.stop();
    },

    Super(superPath) {
      unsafe = true;
      superPath.stop();
    },

    MetaProperty(metaPath) {
      if (!t.isIdentifier(metaPath.node.meta, { name: 'new' })) return;
      if (!t.isIdentifier(metaPath.node.property, { name: 'target' })) return;
      unsafe = true;
      metaPath.stop();
    },

    Identifier(identifierPath) {
      if (!identifierPath.isReferencedIdentifier({ name: 'arguments' })) return;
      if (identifierPath.scope.hasBinding('arguments')) return;
      unsafe = true;
      identifierPath.stop();
    },

    CallExpression(callPath) {
      const calleePath = callPath.get('callee');
      if (!calleePath.isIdentifier({ name: 'eval' })) return;
      if (callPath.scope.hasBinding('eval')) return;
      unsafe = true;
      callPath.stop();
    }
  });

  return unsafe;
}

function canRewriteBoundFunctionExpression(functionPath) {
  const declaratorPath = functionPath.parentPath;
  if (!declaratorPath || !declaratorPath.isVariableDeclarator() || declaratorPath.node.init !== functionPath.node) {
    return false;
  }

  const idPath = declaratorPath.get('id');
  if (!idPath.isIdentifier()) return false;

  const binding = functionPath.scope.getBinding(idPath.node.name);
  if (!binding || !binding.constant) return false;

  for (const referencePath of binding.referencePaths) {
    const referenceParent = referencePath.parentPath;
    if (referenceParent && referenceParent.isCallExpression() && referenceParent.node.callee === referencePath.node) {
      continue;
    }
    if (referenceParent && typeof referenceParent.isOptionalCallExpression === 'function' &&
        referenceParent.isOptionalCallExpression() &&
        referenceParent.node.callee === referencePath.node) {
      continue;
    }
    return false;
  }

  return true;
}

function canRewriteFunctionExpressionToArrow(functionPath) {
  const node = functionPath.node;
  if (!functionPath.isFunctionExpression()) return false;
  if (node.id) return false;
  if (node.generator) return false;
  if (hasDuplicateParamBindings(node.params)) return false;
  if (hasArrowUnsafeSemantics(functionPath)) return false;
  return canRewriteBoundFunctionExpression(functionPath);
}

function buildArrowFunctionReplacement(functionNode) {
  let body = t.cloneNode(functionNode.body, true);
  if (t.isBlockStatement(functionNode.body) &&
      (!functionNode.body.directives || functionNode.body.directives.length === 0) &&
      functionNode.body.body.length === 1 &&
      t.isReturnStatement(functionNode.body.body[0]) &&
      functionNode.body.body[0].argument) {
    body = t.cloneNode(functionNode.body.body[0].argument, true);
  }

  const arrow = t.arrowFunctionExpression(
    functionNode.params.map((param) => t.cloneNode(param, true)),
    body,
    functionNode.async
  );

  if (functionNode.typeParameters) arrow.typeParameters = t.cloneNode(functionNode.typeParameters, true);
  if (functionNode.returnType) arrow.returnType = t.cloneNode(functionNode.returnType, true);

  return arrow;
}

function optimizeArrowFunctions(ast, report) {
  let candidateCount = 0;

  traverse(ast, {
    FunctionExpression: {
      exit(functionPath) {
        if (!canRewriteFunctionExpressionToArrow(functionPath)) return;

        candidateCount += 1;
        const before = codeByteLength(minifiedNode(functionPath.node));
        const replacement = buildArrowFunctionReplacement(functionPath.node);
        const after = codeByteLength(minifiedNode(replacement));
        const saving = before - after;
        if (saving <= 0) return;

        const location = functionPath.node.loc?.start || null;
        functionPath.replaceWith(replacement);

        report.arrowSummary.rewritten += 1;
        report.arrowFunctions.push({
          before,
          after,
          saving,
          location
        });
      }
    }
  });

  report.arrowSummary.candidates = candidateCount;
}

function allocateInstanceofHelperName(rootPath) {
  const usedNames = collectUsedNames(rootPath);
  for (const candidate of identifierNames()) {
    if (!usedNames.has(candidate) && t.isValidIdentifier(candidate, true)) return candidate;
  }

  throw new Error('Could not allocate instanceof helper name');
}

function createInstanceofHelperDeclaration(helperName) {
  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier(helperName),
      t.arrowFunctionExpression(
        [t.identifier('v'), t.identifier('C')],
        t.binaryExpression('instanceof', t.identifier('v'), t.identifier('C'))
      )
    )
  ]);
}

function optimizeInstanceofHelpers(ast, report) {
  const records = new Map();
  let candidateCount = 0;

  traverse(ast, {
    BinaryExpression(binaryPath) {
      if (binaryPath.node.operator !== 'instanceof') return;

      const rootPath = getOutermostFunction(binaryPath);
      if (!rootPath || !isInRootBody(binaryPath, rootPath)) return;

      let record = records.get(rootPath.node);
      if (!record) {
        record = { rootPath, instances: [] };
        records.set(rootPath.node, record);
      }

      candidateCount += 1;
      record.instances.push({
        path: binaryPath,
        left: t.cloneNode(binaryPath.node.left, true),
        right: t.cloneNode(binaryPath.node.right, true),
        location: binaryPath.node.loc?.start || null
      });
    }
  });

  report.instanceofSummary.candidates = candidateCount;

  for (const record of records.values()) {
    const rewrites = record.instances.filter((instance) => instance.path && !instance.path.removed);
    if (!rewrites.length) continue;

    const helperName = allocateInstanceofHelperName(record.rootPath);
    insertDeclaration(record.rootPath, createInstanceofHelperDeclaration(helperName));
    report.instanceofSummary.helpersInserted += 1;
    report.instanceofHelpers.push({
      helper: helperName,
      scopeStart: record.rootPath.node.loc?.start || null
    });

    for (const instance of rewrites) {
      instance.path.replaceWith(
        t.callExpression(t.identifier(helperName), [
          t.cloneNode(instance.left, true),
          t.cloneNode(instance.right, true)
        ])
      );
      report.instanceofSummary.rewritten += 1;
      report.instanceofRewrites.push({
        helper: helperName,
        location: instance.location
      });
    }
  }
}

function analyzeObjectArrayUnpackCandidate(arrayNode) {
  if (!t.isArrayExpression(arrayNode)) return null;
  if (arrayNode.elements.length < 2) return null;
  if (!arrayNode.elements.every((element) => t.isObjectExpression(element))) return null;

  const firstObject = arrayNode.elements[0];
  const keyOrder = [];
  const seen = new Set();

  for (const property of firstObject.properties) {
    if (!t.isObjectProperty(property) || property.computed) return null;
    const keyName = getStaticObjectKeyName(property.key);
    if (!keyName || keyName === '__proto__' || seen.has(keyName)) return null;
    seen.add(keyName);
    keyOrder.push(keyName);
  }

  if (keyOrder.length === 0) return null;

  const rows = [];
  for (const objectElement of arrayNode.elements) {
    if (!t.isObjectExpression(objectElement)) return null;
    if (objectElement.properties.length !== keyOrder.length) return null;

    const row = [];
    for (let index = 0; index < keyOrder.length; index += 1) {
      const property = objectElement.properties[index];
      if (!t.isObjectProperty(property) || property.computed) return null;
      const keyName = getStaticObjectKeyName(property.key);
      if (keyName !== keyOrder[index] || keyName === '__proto__') return null;
      row.push(t.cloneNode(property.value, true));
    }
    rows.push(row);
  }

  return {
    keys: keyOrder,
    rows
  };
}

function allocateUnpackingHelperName(rootPath) {
  const usedNames = collectUsedNames(rootPath);
  for (const candidate of identifierNames()) {
    if (!usedNames.has(candidate) && t.isValidIdentifier(candidate, true)) return candidate;
  }

  throw new Error('Could not allocate object-unpacking helper name');
}

function createUnpackingHelperDeclaration(helperName) {
  const valuesId = t.identifier('values');
  const keysId = t.identifier('keys');
  const outId = t.identifier('out');
  const valueId = t.identifier('value');
  const indexId = t.identifier('index');

  const keyOffsetExpression = () => t.binaryExpression(
    '%',
    t.cloneNode(indexId),
    t.memberExpression(t.cloneNode(keysId), t.identifier('length'))
  );

  const objectSlotExpression = () => t.memberExpression(
    t.cloneNode(outId),
    t.binaryExpression(
      '-',
      t.memberExpression(t.cloneNode(outId), t.identifier('length')),
      t.numericLiteral(1)
    ),
    true
  );

  const ensureRowExpression = t.logicalExpression(
    '||',
    keyOffsetExpression(),
    t.callExpression(
      t.memberExpression(t.cloneNode(outId), t.identifier('push')),
      [t.objectExpression([])]
    )
  );

  const assignExpression = t.assignmentExpression(
    '=',
    t.memberExpression(
      objectSlotExpression(),
      t.memberExpression(t.cloneNode(keysId), keyOffsetExpression(), true),
      true
    ),
    t.cloneNode(valueId)
  );

  const reducer = t.arrowFunctionExpression(
    [outId, valueId, indexId],
    t.sequenceExpression([
      ensureRowExpression,
      assignExpression,
      t.cloneNode(outId)
    ])
  );

  const reduceCall = t.callExpression(
    t.memberExpression(t.cloneNode(valuesId), t.identifier('reduce')),
    [reducer, t.arrayExpression([])]
  );

  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier(helperName),
      t.arrowFunctionExpression([valuesId, t.restElement(keysId)], reduceCall)
    )
  ]);
}

function buildObjectUnpackCall(helperName, keys, rows) {
  const flatValues = [];
  for (const row of rows) {
    for (const value of row) flatValues.push(t.cloneNode(value, true));
  }

  return t.callExpression(
    t.identifier(helperName),
    [
      t.arrayExpression(flatValues),
      ...keys.map((key) => t.stringLiteral(key))
    ]
  );
}

function optimizeObjectArrayUnpacking(ast, report) {
  const records = new Map();
  let candidateCount = 0;

  traverse(ast, {
    ArrayExpression: {
      exit(arrayPath) {
        const analysis = analyzeObjectArrayUnpackCandidate(arrayPath.node);
        if (!analysis) return;

        const rootPath = getOutermostFunction(arrayPath);
        if (!rootPath || !isInRootBody(arrayPath, rootPath)) return;

        let record = records.get(rootPath.node);
        if (!record) {
          record = { rootPath, candidates: [] };
          records.set(rootPath.node, record);
        }

        candidateCount += 1;
        record.candidates.push({
          path: arrayPath,
          keys: analysis.keys,
          rows: analysis.rows,
          location: arrayPath.node.loc?.start || null
        });
      }
    }
  });

  report.objectUnpackSummary.candidates = candidateCount;

  for (const record of records.values()) {
    const helperName = allocateUnpackingHelperName(record.rootPath);
    const helperDeclaration = createUnpackingHelperDeclaration(helperName);
    const helperBytes = codeByteLength(minifiedNode(helperDeclaration));
    const rewritten = [];
    let localSavings = 0;

    for (const candidate of record.candidates) {
      if (!candidate.path || candidate.path.removed) continue;

      const replacement = buildObjectUnpackCall(helperName, candidate.keys, candidate.rows);
      const before = codeByteLength(minifiedNode(candidate.path.node));
      const after = codeByteLength(minifiedNode(replacement));
      const saving = before - after;
      if (saving <= 0) continue;

      rewritten.push({ candidate, replacement, before, after, saving });
      localSavings += saving;
    }

    if (!rewritten.length) continue;

    const netSaving = localSavings - helperBytes;

    insertDeclaration(record.rootPath, helperDeclaration);
    report.objectUnpackSummary.helpersInserted += 1;
    report.objectUnpackSummary.helperBytes += helperBytes;
    report.objectUnpackSummary.netRawSaving += netSaving;

    for (const item of rewritten) {
      item.candidate.path.replaceWith(item.replacement);
      report.objectUnpackSummary.rewritten += 1;
      report.objectUnpacks.push({
        helper: helperName,
        keys: item.candidate.keys,
        items: item.candidate.rows.length,
        before: item.before,
        after: item.after,
        saving: item.saving,
        location: item.candidate.location
      });
    }
  }
}

function collectCandidates(ast, opts) {
  const scopeMap = new Map();
  const allowOffsetless = Boolean(opts.objectUnpacking);

  traverse(ast, {
    StringLiteral(stringPath) {
      if (!opts.aliasStrings) return;
      if (isDirectiveString(stringPath) || isKeyPosition(stringPath) ||
          isStaticModuleSpecifier(stringPath) || isInsideJsx(stringPath)) return;

      const rootPath = getOutermostFunction(stringPath);
      if (!rootPath || !isInRootBody(stringPath, rootPath, allowOffsetless)) return;

      const value = stringPath.node.value;
      if (value.length === 0) return;
      const record = getScopeRecord(scopeMap, rootPath);
      addOccurrence(record, `s:${value}`, 'string', value, {
        kind: 'string',
        path: stringPath,
        oldCost: stringLiteralLength(value),
        overhead: 0
      });
    },

    MemberExpression(memberPath) {
      if (!opts.aliasProperties || memberPath.node.computed || !t.isIdentifier(memberPath.node.property)) return;
      const rootPath = getOutermostFunction(memberPath);
      if (!rootPath || !isInRootBody(memberPath, rootPath, allowOffsetless)) return;

      const value = memberPath.node.property.name;
      const record = getScopeRecord(scopeMap, rootPath);
      addOccurrence(record, `s:${value}`, 'string', value, {
        kind: 'member',
        path: memberPath,
        oldCost: value.length + 1,
        overhead: 2
      });
    },

    OptionalMemberExpression(memberPath) {
      if (!opts.aliasProperties || memberPath.node.computed || !t.isIdentifier(memberPath.node.property)) return;
      const rootPath = getOutermostFunction(memberPath);
      if (!rootPath || !isInRootBody(memberPath, rootPath, allowOffsetless)) return;

      const value = memberPath.node.property.name;
      const record = getScopeRecord(scopeMap, rootPath);
      addOccurrence(record, `s:${value}`, 'string', value, {
        kind: 'member',
        path: memberPath,
        oldCost: value.length + 2,
        overhead: 3
      });
    },

    ObjectProperty(propertyPath) {
      collectPropertyKey(propertyPath, scopeMap, opts);
    },
    ObjectMethod(methodPath) {
      collectPropertyKey(methodPath, scopeMap, opts);
    },
    ClassMethod(methodPath) {
      if (methodPath.node.kind === 'constructor') return;
      collectPropertyKey(methodPath, scopeMap, opts);
    },
    ClassProperty(propertyPath) {
      collectPropertyKey(propertyPath, scopeMap, opts);
    },
    ClassAccessorProperty(propertyPath) {
      collectPropertyKey(propertyPath, scopeMap, opts);
    },

    ReferencedIdentifier(identifierPath) {
      const name = identifierPath.node.name;
      if (identifierPath.scope.getBinding(name)) return;

      const rootPath = getOutermostFunction(identifierPath);
      if (!rootPath || !isInRootBody(identifierPath, rootPath, allowOffsetless)) return;

      const record = getScopeRecord(scopeMap, rootPath);

      if (opts.aliasUndefined && name === 'undefined') {
        addOccurrence(record, 'u:undefined', 'undefined', 'undefined', {
          kind: 'undefinedValue',
          path: identifierPath,
          oldCost: name.length,
          overhead: 0
        });
        return;
      }

      if (!opts.aliasGlobals) return;
      if (!SAFE_GLOBALS.has(name)) return;

      addOccurrence(record, `g:${name}`, 'global', name, {
        kind: 'global',
        path: identifierPath,
        oldCost: name.length,
        overhead: 0
      });
    },

    UnaryExpression(unaryPath) {
      if (!opts.aliasUndefined) return;
      if (unaryPath.node.operator !== 'void') return;
      if (!t.isNumericLiteral(unaryPath.node.argument, { value: 0 })) return;

      const rootPath = getOutermostFunction(unaryPath);
      if (!rootPath || !isInRootBody(unaryPath, rootPath, allowOffsetless)) return;

      const record = getScopeRecord(scopeMap, rootPath);
      addOccurrence(record, 'u:undefined', 'undefined', 'undefined', {
        kind: 'undefinedValue',
        path: unaryPath,
        oldCost: codeByteLength(minifiedNode(unaryPath.node)),
        overhead: 0
      });
    }
  });

  return scopeMap;
}

function collectPropertyKey(propertyPath, scopeMap, opts) {
  if (!opts.aliasProperties || propertyPath.node.computed) return;
  if (propertyPath.isObjectProperty() && propertyPath.node.shorthand) return;

  const key = propertyPath.node.key;
  let value;
  let oldCost;
  if (t.isIdentifier(key)) {
    value = key.name;
    oldCost = value.length;
  } else if (t.isStringLiteral(key)) {
    value = key.value;
    oldCost = stringLiteralLength(value);
  } else {
    return;
  }

  if (value === '__proto__') return;
  const rootPath = getOutermostFunction(propertyPath);
  if (!rootPath || !isInRootBody(propertyPath, rootPath, opts.objectUnpacking)) return;

  const record = getScopeRecord(scopeMap, rootPath);
  addOccurrence(record, `s:${value}`, 'string', value, {
    kind: 'propertyKey',
    path: propertyPath,
    oldCost,
    overhead: 2
  });
}

function collectUsedNames(rootPath) {
  const used = new Set();
  rootPath.traverse({
    Identifier(identifierPath) {
      used.add(identifierPath.node.name);
    }
  });
  if (rootPath.node.id && t.isIdentifier(rootPath.node.id)) used.add(rootPath.node.id.name);
  return used;
}

function collectForbiddenGlobalWrites(rootPath) {
  const names = new Set();
  rootPath.traverse({
    AssignmentExpression(assignPath) {
      collectAssignedIdentifiers(assignPath.node.left, names);
    },
    UpdateExpression(updatePath) {
      collectAssignedIdentifiers(updatePath.node.argument, names);
    },
    UnaryExpression(unaryPath) {
      if (unaryPath.node.operator === 'delete') collectAssignedIdentifiers(unaryPath.node.argument, names);
    }
  });
  return names;
}

function collectAssignedIdentifiers(node, output) {
  if (!node) return;
  if (t.isIdentifier(node)) {
    output.add(node.name);
    return;
  }
  if (t.isRestElement(node)) return collectAssignedIdentifiers(node.argument, output);
  if (t.isAssignmentPattern(node)) return collectAssignedIdentifiers(node.left, output);
  if (t.isArrayPattern(node)) {
    node.elements.forEach((element) => collectAssignedIdentifiers(element, output));
    return;
  }
  if (t.isObjectPattern(node)) {
    node.properties.forEach((property) => {
      if (t.isRestElement(property)) collectAssignedIdentifiers(property.argument, output);
      else collectAssignedIdentifiers(property.value, output);
    });
  }
}

function* identifierNames() {
  const first = ['$', '_', ...'abcdefghijklmnopqrstuvwxyz', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const rest = [...first, ...'0123456789'];
  for (const char of first) yield char;
  for (let length = 2; length <= 5; length += 1) {
    const indexes = new Array(length).fill(0);
    while (true) {
      let name = first[indexes[0]];
      for (let i = 1; i < length; i += 1) name += rest[indexes[i]];
      if (t.isValidIdentifier(name, false)) yield name;

      let position = length - 1;
      while (position >= 1) {
        indexes[position] += 1;
        if (indexes[position] < rest.length) break;
        indexes[position] = 0;
        position -= 1;
      }
      if (position === 0) {
        indexes[0] += 1;
        if (indexes[0] >= first.length) break;
      }
    }
  }
}

function candidateInitLength(candidate) {
  if (candidate.initKind === 'string') return stringLiteralLength(candidate.value);
  if (candidate.initKind === 'undefined') return codeByteLength(minifiedNode(t.unaryExpression('void', t.numericLiteral(0), true)));
  return candidate.value.length;
}

function candidateDeclarationEntryLength(candidate, aliasLength) {
  return aliasLength + 1 + candidateInitLength(candidate) + 1;
}

function grossSaving(candidate, aliasLength) {
  return candidate.occurrences.reduce(
    (total, occurrence) => total + occurrence.oldCost - (aliasLength + occurrence.overhead),
    0
  );
}

function candidateAssignmentScore(candidate) {
  if (Number.isFinite(candidate.estimatedSaving)) return candidate.estimatedSaving;
  if (Number.isFinite(candidate.roughSaving)) return candidate.roughSaving;
  return Number.NEGATIVE_INFINITY;
}

function sortForAliasAssignment(candidates) {
  candidates.sort((a, b) =>
    candidateAssignmentScore(b) - candidateAssignmentScore(a) ||
    b.occurrences.length - a.occurrences.length
  );
}

function chooseAliases(record, opts) {
  if (!record.forbiddenGlobalWrites) {
    record.forbiddenGlobalWrites = collectForbiddenGlobalWrites(record.rootPath);
  }

  let candidates = [...record.candidates.values()]
    .filter((candidate) => candidate.occurrences.length >= opts.minOccurrences)
    .filter((candidate) => {
      if (candidate.initKind !== 'global' && candidate.initKind !== 'undefined') return true;
      return !record.forbiddenGlobalWrites.has(candidate.value);
    });

  // First rank by likely value, so a repeated long token is not excluded merely
  // because a short token occurs more often.
  candidates.forEach((candidate) => {
    const assumedAliasLength = 2;
    candidate.roughSaving = grossSaving(candidate, assumedAliasLength) -
      candidateDeclarationEntryLength(candidate, assumedAliasLength);
  });
  candidates.sort((a, b) => b.roughSaving - a.roughSaving);
  candidates = candidates.slice(0, Math.max(opts.maxAliases * 3, opts.maxAliases));

  for (let pass = 0; pass < 4; pass += 1) {
    // Highest projected byte-gain candidates get the shortest aliases.
    sortForAliasAssignment(candidates);
    const aliases = allocateAliasNamesFresh(record, candidates.length);
    candidates.forEach((candidate, index) => { candidate.alias = aliases[index]; });

    candidates = candidates.filter((candidate) => {
      const gross = grossSaving(candidate, codeByteLength(candidate.alias));
      const declarationEntry = candidateDeclarationEntryLength(candidate, codeByteLength(candidate.alias));
      candidate.estimatedSaving = gross - declarationEntry;
      return candidate.estimatedSaving >= opts.minSaving;
    });

    candidates.sort((a, b) => b.estimatedSaving - a.estimatedSaving);
    candidates = candidates.slice(0, opts.maxAliases);
  }

  // "const " and the final semicolon are shared overhead not charged above.
  while (candidates.length && candidates.reduce((sum, candidate) => sum + candidate.estimatedSaving, 0) <= 6) {
    candidates.sort((a, b) => a.estimatedSaving - b.estimatedSaving);
    candidates.shift();
  }

  // One final name assignment after the selected set stabilizes.
  sortForAliasAssignment(candidates);
  const aliases = allocateAliasNamesFresh(record, candidates.length);
  candidates.forEach((candidate, index) => {
    candidate.alias = aliases[index];
    const gross = grossSaving(candidate, codeByteLength(candidate.alias));
    const declarationEntry = candidateDeclarationEntryLength(candidate, codeByteLength(candidate.alias));
    candidate.estimatedSaving = gross - declarationEntry;
  });

  return candidates;
}

function allocateAliasNamesFresh(record, count) {
  if (count === 0) return [];
  const allUsed = collectUsedNames(record.rootPath);
  const output = [];
  for (const name of identifierNames()) {
    if (allUsed.has(name)) continue;
    allUsed.add(name);
    output.push(name);
    if (output.length >= count) return output;
  }
  throw new Error('Could not allocate collision-free alias names');
}

function applyAliases(scopeMap, opts, report) {
  for (const record of scopeMap.values()) {
    const selected = chooseAliases(record, opts);
    if (!selected.length) continue;

    const declarators = [];
    for (const candidate of selected) {
      const aliasId = t.identifier(candidate.alias);
      let init;
      if (candidate.initKind === 'string') init = t.stringLiteral(candidate.value);
      else if (candidate.initKind === 'undefined') init = t.unaryExpression('void', t.numericLiteral(0), true);
      else init = t.identifier(candidate.value);
      declarators.push(t.variableDeclarator(t.cloneNode(aliasId), init));

      let applied = 0;
      for (const occurrence of candidate.occurrences) {
        if (!occurrence.path || occurrence.path.removed) continue;
        applyOccurrence(occurrence, candidate.alias);
        applied += 1;
      }

      report.aliases.push({
        alias: candidate.alias,
        value: candidate.value,
        type: candidate.initKind,
        occurrences: applied,
        estimatedSaving: candidate.estimatedSaving,
        scopeStart: record.rootPath.node.loc?.start || null
      });
    }

    insertDeclaration(record.rootPath, t.variableDeclaration('const', declarators));
  }
}

function applyOccurrence(occurrence, alias) {
  const id = t.identifier(alias);
  switch (occurrence.kind) {
    case 'string':
    case 'global':
    case 'undefinedValue':
      occurrence.path.replaceWith(id);
      break;
    case 'member':
      occurrence.path.node.computed = true;
      occurrence.path.node.property = id;
      break;
    case 'propertyKey':
      occurrence.path.node.computed = true;
      occurrence.path.node.key = id;
      break;
    default:
      throw new Error(`Unknown occurrence kind: ${occurrence.kind}`);
  }
}

function insertDeclaration(functionPath, declaration) {
  const body = functionPath.node.body;
  if (t.isBlockStatement(body)) {
    body.body.unshift(declaration);
    return;
  }

  // Arrow with an expression body: () => expr  ->  () => { const ...; return expr }
  functionPath.node.body = t.blockStatement([
    declaration,
    t.returnStatement(body)
  ]);
}

async function printCode(ast, opts) {
  const generated = generate(ast, {
    comments: true,
    compact: true,
    minified: true,
    retainLines: false,
    jsescOption: { minimal: true }
  }).code;

  if (!opts.terserPrint) return generated;
  const result = await minify(generated, {
    compress: false,
    mangle: false,
    ecma: 2022,
    module: false,
    format: {
      comments: /^!/,
      ascii_only: false,
      semicolons: true,
      wrap_iife: false
    }
  });
  if (!result.code) throw new Error('Terser returned no code');
  return result.code;
}

function isSmallerBundle(a, b) {
  if (a.raw !== b.raw) return a.raw < b.raw;
  if (a.gzip !== b.gzip) return a.gzip < b.gzip;
  return a.brotli <= b.brotli;
}

function isSmallerCompressedBundle(a, b) {
  const aCompressed = a.gzip + a.brotli;
  const bCompressed = b.gzip + b.brotli;
  if (aCompressed !== bCompressed) return aCompressed < bCompressed;
  return a.raw <= b.raw;
}

async function optimizeOnce(input, opts, beforeStats, stringArraysEnabled, stringConcatsEnabled, stringConcatMinSaving = 1) {
  const runOpts = { ...opts, stringArrays: stringArraysEnabled };
  const ast = parseCode(input, opts.inputFile);
  const report = {
    input: opts.inputFile,
    output: opts.outputFile,
    options: { ...runOpts, positional: undefined, inputFile: undefined, outputFile: undefined },
    stringArrays: [],
    stringConcats: [],
    arrowFunctions: [],
    instanceofHelpers: [],
    instanceofRewrites: [],
    objectUnpacks: [],
    aliases: [],
    before: beforeStats,
    after: null,
    savings: null,
    arrayCompaction: null,
    concatCompaction: null,
    arrowSummary: {
      candidates: 0,
      rewritten: 0
    },
    instanceofSummary: {
      candidates: 0,
      rewritten: 0,
      helpersInserted: 0
    },
    objectUnpackSummary: {
      candidates: 0,
      rewritten: 0,
      helpersInserted: 0,
      helperBytes: 0,
      netRawSaving: 0
    },
    strictNormalization: {
      enabled: runOpts.assumeStrict,
      removed: 0,
      inserted: 0
    }
  };

  if (runOpts.assumeStrict) normalizeStrictDirectives(ast, report);
  compactStringArrays(ast, runOpts, report);
  if (stringConcatsEnabled) optimizeStringConcats(ast, report, stringConcatMinSaving);
  if (runOpts.objectUnpacking) optimizeObjectArrayUnpacking(ast, report);
  const scopeMap = collectCandidates(ast, runOpts);
  applyAliases(scopeMap, runOpts, report);
  if (runOpts.instanceofHelper) optimizeInstanceofHelpers(ast, report);
  if (runOpts.arrowFunctions) optimizeArrowFunctions(ast, report);
  const output = await printCode(ast, runOpts);

  // Final parser pass catches accidental invalid output before writing it.
  parseCode(output, opts.outputFile);

  const afterStats = byteStats(output);
  report.after = afterStats;
  report.savings = {
    raw: beforeStats.raw - afterStats.raw,
    gzip: beforeStats.gzip - afterStats.gzip,
    brotli: beforeStats.brotli - afterStats.brotli
  };

  return { output, report, afterStats };
}

async function optimizeWithConcatGuard(input, opts, beforeStats, stringArraysEnabled) {
  const withConcatsLoose = await optimizeOnce(input, opts, beforeStats, stringArraysEnabled, true, 1);
  const withConcatsStrict = await optimizeOnce(input, opts, beforeStats, stringArraysEnabled, true, 4);
  const withoutConcats = await optimizeOnce(input, opts, beforeStats, stringArraysEnabled, false, 1);
  const bestConcatVariant = isSmallerCompressedBundle(withConcatsStrict.afterStats, withConcatsLoose.afterStats)
    ? withConcatsStrict
    : withConcatsLoose;

  const candidateCount = bestConcatVariant.report.stringConcats.length;
  const attempted = candidateCount > 0;
  const keepConcats = attempted && isSmallerCompressedBundle(bestConcatVariant.afterStats, withoutConcats.afterStats);
  const chosen = keepConcats ? bestConcatVariant : withoutConcats;
  const minSavingUsed = bestConcatVariant === withConcatsStrict ? 4 : 1;

  chosen.report.concatCompaction = {
    attempted,
    selected: keepConcats,
    candidateCount,
    minSavingUsed,
    rawDiffVsNoConcats: withoutConcats.afterStats.raw - bestConcatVariant.afterStats.raw,
    gzipDiffVsNoConcats: withoutConcats.afterStats.gzip - bestConcatVariant.afterStats.gzip,
    brotliDiffVsNoConcats: withoutConcats.afterStats.brotli - bestConcatVariant.afterStats.brotli
  };

  return chosen;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = fs.readFileSync(opts.inputFile, 'utf8');
  const beforeStats = byteStats(input);
  let chosen;

  if (opts.stringArrays) {
    const withArrays = await optimizeWithConcatGuard(input, opts, beforeStats, true);
    const withoutArrays = await optimizeWithConcatGuard(input, opts, beforeStats, false);
    const keepArrays = isSmallerBundle(withArrays.afterStats, withoutArrays.afterStats);

    chosen = keepArrays ? withArrays : withoutArrays;
    chosen.report.arrayCompaction = {
      attempted: true,
      selected: keepArrays,
      candidateCount: withArrays.report.stringArrays.length,
      rawDiffVsNoArrays: withoutArrays.afterStats.raw - withArrays.afterStats.raw,
      gzipDiffVsNoArrays: withoutArrays.afterStats.gzip - withArrays.afterStats.gzip,
      brotliDiffVsNoArrays: withoutArrays.afterStats.brotli - withArrays.afterStats.brotli
    };
  } else {
    chosen = await optimizeWithConcatGuard(input, opts, beforeStats, false);
    chosen.report.arrayCompaction = {
      attempted: false,
      selected: false,
      candidateCount: 0,
      rawDiffVsNoArrays: 0,
      gzipDiffVsNoArrays: 0,
      brotliDiffVsNoArrays: 0
    };
  }

  fs.writeFileSync(opts.outputFile, chosen.output);

  const report = chosen.report;
  const afterStats = report.after;

  if (opts.reportFile) {
    fs.writeFileSync(path.resolve(opts.reportFile), `${JSON.stringify(report, null, 2)}\n`);
  }

  const percent = (saved, original) => `${((saved / original) * 100).toFixed(3)}%`;
  const arrayLine = report.arrayCompaction.attempted && !report.arrayCompaction.selected
    ? `String arrays compacted: 0 (skipped: no net bundle gain)`
    : `String arrays compacted: ${report.stringArrays.length}`;
  const concatLine = report.concatCompaction.attempted && !report.concatCompaction.selected
    ? `String concatenations rewritten: 0 (skipped: no net compressed gain)`
    : `String concatenations rewritten: ${report.stringConcats.length}`;
  const arrowLine = `Arrow function rewrites: ${report.arrowSummary.rewritten}`;
  const instanceofLine = `Instanceof rewrites: ${report.instanceofSummary.rewritten}`;
  const unpackLine = `Object arrays unpacked: ${report.objectUnpackSummary.rewritten}`;
  const strictLine = report.strictNormalization.enabled
    ? `Strict directives normalized: removed ${report.strictNormalization.removed}, inserted ${report.strictNormalization.inserted}`
    : null;

  const outputLines = [
    `Wrote ${opts.outputFile}`,
    arrayLine,
    concatLine,
    arrowLine,
    instanceofLine,
    unpackLine,
    `Aliases inserted: ${report.aliases.length}`,
    `Raw:    ${beforeStats.raw} -> ${afterStats.raw}  saved ${report.savings.raw} (${percent(report.savings.raw, beforeStats.raw)})`,
    `Gzip:   ${beforeStats.gzip} -> ${afterStats.gzip}  saved ${report.savings.gzip} (${percent(report.savings.gzip, beforeStats.gzip)})`,
    `Brotli: ${beforeStats.brotli} -> ${afterStats.brotli}  saved ${report.savings.brotli} (${percent(report.savings.brotli, beforeStats.brotli)})`,
    ''
  ];
  if (strictLine) outputLines.splice(3, 0, strictLine);

  process.stdout.write([
    ...outputLines
  ].join('\n'));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
