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
  --max-aliases <n>       Maximum aliases per top-level function scope (default: 80)
  --array-min-items <n>   Minimum strings in an array before trying join/split (default: 6)
  --array-min-saving <n>  Minimum raw-byte saving for an array rewrite (default: 2)
  --no-string-arrays      Disable string-array compaction
  --no-alias-globals      Do not alias safe built-ins such as Object or Array
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
    maxAliases: 80,
    arrayMinItems: 6,
    arrayMinSaving: 2,
    stringArrays: true,
    aliasGlobals: true,
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
    if (arg === '--no-string-arrays') opts.stringArrays = false;
    else if (arg === '--no-alias-globals') opts.aliasGlobals = false;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLiteralModuleId(node) {
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return node.value;
  return null;
}

function createModuleIdLiteral(templateNode, moduleId) {
  const numeric = Number(moduleId);
  const canUseNumeric = Number.isInteger(numeric) && String(numeric) === moduleId;

  if (t.isNumericLiteral(templateNode) && canUseNumeric) {
    return t.numericLiteral(numeric);
  }
  if (t.isStringLiteral(templateNode)) {
    return t.stringLiteral(moduleId);
  }
  return canUseNumeric ? t.numericLiteral(numeric) : t.stringLiteral(moduleId);
}

function isRequireCallExpression(node, requireName) {
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return false;
  if (!t.isIdentifier(node.callee)) return false;
  if (requireName) return node.callee.name === requireName;
  return true;
}

function parseModuleIdToken(token) {
  const value = token.trim();
  if (/^\d+$/.test(value)) return String(Number.parseInt(value, 10));
  const match = value.match(/^(["'])(.*)\1$/);
  if (match) return match[2];
  return null;
}

function getObjectKeyName(keyNode) {
  if (t.isNumericLiteral(keyNode)) return String(keyNode.value);
  if (t.isStringLiteral(keyNode)) return keyNode.value;
  if (t.isIdentifier(keyNode)) return keyNode.name;
  return null;
}

function getModuleFunctionNode(propertyNode) {
  if (t.isObjectMethod(propertyNode)) return propertyNode;
  if (t.isObjectProperty(propertyNode) &&
      (t.isFunctionExpression(propertyNode.value) || t.isArrowFunctionExpression(propertyNode.value))) {
    return propertyNode.value;
  }
  return null;
}

function getDefaultExportTarget(node) {
  if (!t.isArrowFunctionExpression(node) && !t.isFunctionExpression(node)) return null;
  if (node.params.length !== 0) return null;

  if (t.isBlockStatement(node.body)) {
    const returnStatement = node.body.body.find((statement) => t.isReturnStatement(statement));
    if (!returnStatement || !returnStatement.argument) return null;
    return minifiedNode(returnStatement.argument);
  }

  return minifiedNode(node.body);
}

function isModuleExportsTarget(node, moduleName) {
  if (!moduleName || !t.isMemberExpression(node) || node.computed) return false;
  return t.isIdentifier(node.object, { name: moduleName }) && t.isIdentifier(node.property, { name: 'exports' });
}

function isExportsTarget(node, exportsName) {
  if (!exportsName || !t.isMemberExpression(node)) return false;
  return t.isIdentifier(node.object, { name: exportsName });
}

function isExportHelperCall(node, requireName, exportsName) {
  if (!requireName || !exportsName || !t.isCallExpression(node)) return false;
  if (!t.isMemberExpression(node.callee) || node.callee.computed) return false;
  if (!t.isIdentifier(node.callee.object, { name: requireName })) return false;
  if (!t.isIdentifier(node.callee.property)) return false;

  const helper = node.callee.property.name;
  if (helper !== 'd' && helper !== 'r') return false;
  if (node.arguments.length < 1) return false;
  return t.isIdentifier(node.arguments[0], { name: exportsName });
}

function isSafeModuleExpression(expression, requireName, exportsName) {
  if (isExportHelperCall(expression, requireName, exportsName)) return true;
  if (t.isSequenceExpression(expression)) {
    return expression.expressions.every((subExpression) =>
      isSafeModuleExpression(subExpression, requireName, exportsName)
    );
  }
  return false;
}

function isSafeModuleStatement(statement, requireName, exportsName) {
  if (t.isVariableDeclaration(statement) || t.isFunctionDeclaration(statement) ||
      t.isClassDeclaration(statement) || t.isEmptyStatement(statement)) {
    return true;
  }
  if (t.isExpressionStatement(statement)) {
    if (typeof statement.directive === 'string') return true;
    return isSafeModuleExpression(statement.expression, requireName, exportsName);
  }
  return false;
}

function analyzeWebpackExtractableModules(ast) {
  let modulesObject = null;
  traverse(ast, {
    VariableDeclarator(pathRef) {
      if (t.isIdentifier(pathRef.node.id, { name: '__webpack_modules__' }) &&
          t.isObjectExpression(pathRef.node.init)) {
        modulesObject = pathRef.node.init;
        pathRef.stop();
      }
    }
  });

  if (!modulesObject) {
    return {
      detected: false,
      moduleCount: 0,
      modulesWithRequireCalls: 0,
      totalRequireCalls: 0,
      avgRequiresPerModule: 0,
      requireHistogram: { '0': 0, '1': 0, '2': 0, '3-4': 0, '5-9': 0, '10+': 0 },
      helperCalls: { d: 0, r: 0, n: 0, t: 0, o: 0, e: 0 },
      extractable: {
        totalCandidates: 0,
        byType: { defaultLocal: 0, defaultReexport: 0 },
        estimatedWrapperBytes: 0,
        candidatesTop: []
      }
    };
  }

  const requireHistogram = { '0': 0, '1': 0, '2': 0, '3-4': 0, '5-9': 0, '10+': 0 };
  const helperCalls = { d: 0, r: 0, n: 0, t: 0, o: 0, e: 0 };
  const candidates = [];
  let moduleCount = 0;
  let modulesWithRequireCalls = 0;
  let totalRequireCalls = 0;

  for (const propertyNode of modulesObject.properties) {
    const functionNode = getModuleFunctionNode(propertyNode);
    if (!functionNode || functionNode.params.length < 3 || !t.isIdentifier(functionNode.params[2])) continue;

    moduleCount += 1;
    const moduleName = t.isIdentifier(functionNode.params[0]) ? functionNode.params[0].name : null;
    const exportsName = t.isIdentifier(functionNode.params[1]) ? functionNode.params[1].name : null;
    const requireName = functionNode.params[2].name;
    const moduleId = getObjectKeyName(propertyNode.key);
    const moduleHelperCalls = { d: 0, r: 0, n: 0, t: 0, o: 0, e: 0 };
    const requireBindings = new Map();

    let requireCalls = 0;
    let sawDefaultExport = false;
    let sawNamedExport = false;
    let defaultExportTarget = null;
    let hasDirectExportsMutation = false;
    let hasDirectModuleExportsMutation = false;

    const statements = t.isBlockStatement(functionNode.body) ? functionNode.body.body : [];
    const statementCount = statements.length;
    const safeStatements = statements.every((statement) =>
      isSafeModuleStatement(statement, requireName, exportsName)
    );

    traverse(functionNode.body, {
      noScope: true,
      CallExpression(pathRef) {
        const callee = pathRef.node.callee;
        if (t.isIdentifier(callee, { name: requireName })) {
          requireCalls += 1;
          return;
        }

        if (!t.isMemberExpression(callee) || callee.computed ||
            !t.isIdentifier(callee.object, { name: requireName }) || !t.isIdentifier(callee.property)) {
          return;
        }

        const helperName = callee.property.name;
        if (Object.prototype.hasOwnProperty.call(moduleHelperCalls, helperName)) {
          moduleHelperCalls[helperName] += 1;
          helperCalls[helperName] += 1;
        }

        if (helperName !== 'd' || !exportsName) return;

        const args = pathRef.node.arguments;
        if (args.length < 2 || !t.isIdentifier(args[0], { name: exportsName }) || !t.isObjectExpression(args[1])) {
          return;
        }

        let hasDefaultInThisCall = false;
        let hasNamedInThisCall = false;

        for (const definition of args[1].properties) {
          if (!t.isObjectProperty(definition)) {
            hasNamedInThisCall = true;
            continue;
          }
          const keyName = getObjectKeyName(definition.key);
          if (keyName === 'default') {
            hasDefaultInThisCall = true;
            if (!defaultExportTarget) {
              defaultExportTarget = getDefaultExportTarget(definition.value);
            }
          } else {
            hasNamedInThisCall = true;
          }
        }

        if (hasDefaultInThisCall) sawDefaultExport = true;
        if (hasNamedInThisCall) sawNamedExport = true;
      },

      VariableDeclarator(pathRef) {
        if (!t.isIdentifier(pathRef.node.id)) return;
        if (!isRequireCallExpression(pathRef.node.init, requireName)) return;
        const dependencyId = getLiteralModuleId(pathRef.node.init.arguments[0]);
        if (dependencyId == null) return;
        requireBindings.set(pathRef.node.id.name, dependencyId);
      },

      AssignmentExpression(pathRef) {
        if (isExportsTarget(pathRef.node.left, exportsName)) hasDirectExportsMutation = true;
        if (isModuleExportsTarget(pathRef.node.left, moduleName)) hasDirectModuleExportsMutation = true;
      },

      UpdateExpression(pathRef) {
        if (isExportsTarget(pathRef.node.argument, exportsName)) hasDirectExportsMutation = true;
        if (isModuleExportsTarget(pathRef.node.argument, moduleName)) hasDirectModuleExportsMutation = true;
      },

      UnaryExpression(pathRef) {
        if (pathRef.node.operator !== 'delete') return;
        if (isExportsTarget(pathRef.node.argument, exportsName)) hasDirectExportsMutation = true;
        if (isModuleExportsTarget(pathRef.node.argument, moduleName)) hasDirectModuleExportsMutation = true;
      }
    });

    if (requireCalls > 0) modulesWithRequireCalls += 1;
    totalRequireCalls += requireCalls;
    if (requireCalls === 0) requireHistogram['0'] += 1;
    else if (requireCalls === 1) requireHistogram['1'] += 1;
    else if (requireCalls === 2) requireHistogram['2'] += 1;
    else if (requireCalls <= 4) requireHistogram['3-4'] += 1;
    else if (requireCalls <= 9) requireHistogram['5-9'] += 1;
    else requireHistogram['10+'] += 1;

    let reexportSourceModuleId = null;
    if (defaultExportTarget) {
      const memberTarget = defaultExportTarget.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.(?:default)$/);
      if (memberTarget && requireBindings.has(memberTarget[1])) {
        reexportSourceModuleId = requireBindings.get(memberTarget[1]);
      } else {
        const requireTarget = defaultExportTarget.match(
          new RegExp(`^${escapeRegExp(requireName)}\\(([^)]+)\\)\\.(?:default)$`)
        );
        if (requireTarget) {
          reexportSourceModuleId = parseModuleIdToken(requireTarget[1]);
        }
      }
    }

    const defaultOnlyExport = sawDefaultExport && !sawNamedExport;
    const extractionSafe = defaultOnlyExport && safeStatements &&
      !hasDirectExportsMutation && !hasDirectModuleExportsMutation;

    let type = null;
    if (extractionSafe && reexportSourceModuleId) type = 'default-reexport';
    else if (extractionSafe) type = 'default-local';
    if (!type) continue;

    candidates.push({
      moduleId,
      type,
      wrapperBytes: codeByteLength(minifiedNode(propertyNode)),
      statementCount,
      requireCalls,
      defaultExportTarget,
      requireName,
      reexportSourceModuleId,
      helperCalls: moduleHelperCalls
    });
  }

  candidates.sort((a, b) => b.wrapperBytes - a.wrapperBytes || a.requireCalls - b.requireCalls);
  const byType = {
    defaultLocal: candidates.filter((candidate) => candidate.type === 'default-local').length,
    defaultReexport: candidates.filter((candidate) => candidate.type === 'default-reexport').length
  };

  return {
    detected: true,
    moduleCount,
    modulesWithRequireCalls,
    totalRequireCalls,
    avgRequiresPerModule: Number((totalRequireCalls / Math.max(moduleCount, 1)).toFixed(3)),
    requireHistogram,
    helperCalls,
    extractable: {
      totalCandidates: candidates.length,
      byType,
      estimatedWrapperBytes: candidates.reduce((sum, candidate) => sum + candidate.wrapperBytes, 0),
      candidatesTop: candidates.slice(0, 200)
    }
  };
}

function isDefaultMemberAccess(pathRef) {
  const parent = pathRef.parentPath;
  if (!parent) return false;

  if (parent.isMemberExpression() && parent.node.object === pathRef.node) {
    if (!parent.node.computed) return t.isIdentifier(parent.node.property, { name: 'default' });
    return t.isStringLiteral(parent.node.property, { value: 'default' });
  }

  if (parent.isOptionalMemberExpression?.() && parent.node.object === pathRef.node) {
    if (!parent.node.computed) return t.isIdentifier(parent.node.property, { name: 'default' });
    return t.isStringLiteral(parent.node.property, { value: 'default' });
  }

  return false;
}

function hasOnlyDefaultMemberUsages(binding) {
  if (!binding || !binding.constant) return false;
  return binding.referencePaths.every((refPath) => isDefaultMemberAccess(refPath));
}

function getModuleFunctionPath(propertyPath) {
  if (propertyPath.isObjectMethod()) return propertyPath;
  if (!propertyPath.isObjectProperty()) return null;
  const valuePath = propertyPath.get('value');
  if (valuePath.isFunctionExpression() || valuePath.isArrowFunctionExpression()) return valuePath;
  return null;
}

function removeVariableDeclarator(declaratorPath) {
  const declarationPath = declaratorPath.parentPath;
  if (!declarationPath || !declarationPath.isVariableDeclaration()) return;
  if (declarationPath.node.declarations.length <= 1) declarationPath.remove();
  else declaratorPath.remove();
}

function inlineSingleUseRequireBindings(functionPath, requireName) {
  const inlinedDependencyIds = [];
  const bodyPath = functionPath.get('body');
  if (!bodyPath.isBlockStatement()) return inlinedDependencyIds;

  for (const statementPath of bodyPath.get('body')) {
    if (!statementPath.isVariableDeclaration()) continue;

    for (const declaratorPath of statementPath.get('declarations')) {
      if (!declaratorPath.isVariableDeclarator()) continue;
      if (!declaratorPath.get('id').isIdentifier()) continue;
      const initPath = declaratorPath.get('init');
      if (!isRequireCallExpression(initPath.node, requireName)) continue;

      const dependencyId = getLiteralModuleId(initPath.node.arguments[0]);
      if (dependencyId == null) continue;

      const binding = functionPath.scope.getBinding(declaratorPath.node.id.name);
      if (!binding || !binding.constant || binding.path !== declaratorPath) continue;
      if (binding.referencePaths.length !== 1) continue;

      const referencePath = binding.referencePaths[0];
      const parentPath = referencePath.parentPath;
      const isObjectMemberUse = parentPath && (
        (parentPath.isMemberExpression() && parentPath.node.object === referencePath.node) ||
        (parentPath.isOptionalMemberExpression?.() && parentPath.node.object === referencePath.node)
      );
      if (!isObjectMemberUse) continue;

      referencePath.replaceWith(t.cloneNode(initPath.node, true));
      removeVariableDeclarator(declaratorPath);
      inlinedDependencyIds.push(dependencyId);
    }
  }

  return inlinedDependencyIds;
}

function buildWebpackImportRewriteMaps(webpackModuleExtraction) {
  const byRequireName = new Map();
  if (!webpackModuleExtraction || !webpackModuleExtraction.detected) return byRequireName;

  for (const candidate of webpackModuleExtraction.extractable.candidatesTop || []) {
    if (candidate.type !== 'default-reexport') continue;
    if (!candidate.requireName) continue;
    const fromId = candidate.moduleId == null ? null : String(candidate.moduleId);
    const toId = candidate.reexportSourceModuleId == null ? null : String(candidate.reexportSourceModuleId);
    if (!fromId || !toId || fromId === toId) continue;

    let requireMap = byRequireName.get(candidate.requireName);
    if (!requireMap) {
      requireMap = new Map();
      byRequireName.set(candidate.requireName, requireMap);
    }
    requireMap.set(fromId, toId);
  }

  return byRequireName;
}

function optimizeWebpackImports(ast, webpackModuleExtraction) {
  const rewriteMaps = buildWebpackImportRewriteMaps(webpackModuleExtraction);
  const mappingCount = [...rewriteMaps.values()].reduce((sum, mapRef) => sum + mapRef.size, 0);
  const candidateModuleIds = new Set(
    (webpackModuleExtraction?.extractable?.candidatesTop || [])
      .filter((candidate) => candidate.moduleId != null)
      .map((candidate) => String(candidate.moduleId))
  );
  const candidateModules = candidateModuleIds.size;
  const rewriteCounter = new Map();

  const summary = {
    attempted: mappingCount > 0 || candidateModules > 0,
    candidateModules,
    mappingCount,
    inlinedModuleBindings: 0,
    rewrittenDirectDefaultRequires: 0,
    rewrittenBindingInitializers: 0,
    rewrittenTotal: 0,
    rewritesTop: []
  };

  if (!summary.attempted) return summary;

  const noteRewrite = (requireName, fromId, toId) => {
    const key = `${requireName}:${fromId}->${toId}`;
    rewriteCounter.set(key, (rewriteCounter.get(key) || 0) + 1);
  };

  if (candidateModules > 0) {
    traverse(ast, {
      VariableDeclarator(pathRef) {
        if (!t.isIdentifier(pathRef.node.id, { name: '__webpack_modules__' })) return;
        if (!t.isObjectExpression(pathRef.node.init)) return;

        for (const propertyPath of pathRef.get('init.properties')) {
          const moduleId = getObjectKeyName(propertyPath.node.key);
          if (moduleId == null) continue;
          if (!candidateModuleIds.has(String(moduleId))) continue;

          const functionPath = getModuleFunctionPath(propertyPath);
          if (!functionPath || functionPath.node.params.length < 3) continue;
          if (!t.isIdentifier(functionPath.node.params[2])) continue;

          const requireName = functionPath.node.params[2].name;
          const inlinedDependencies = inlineSingleUseRequireBindings(functionPath, requireName);
          summary.inlinedModuleBindings += inlinedDependencies.length;
          inlinedDependencies.forEach((dependencyId) => {
            noteRewrite(requireName, String(moduleId), dependencyId);
          });
        }

        pathRef.stop();
      }
    });
  }

  traverse(ast, {
    CallExpression(callPath) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const requireName = callPath.node.callee.name;
      const requireMap = rewriteMaps.get(requireName);
      if (!requireMap || callPath.node.arguments.length !== 1) return;

      const fromId = getLiteralModuleId(callPath.node.arguments[0]);
      if (fromId == null) return;
      const toId = requireMap.get(fromId);
      if (!toId) return;

      if (!isDefaultMemberAccess(callPath)) return;

      callPath.node.arguments[0] = createModuleIdLiteral(callPath.node.arguments[0], toId);
      summary.rewrittenDirectDefaultRequires += 1;
      noteRewrite(requireName, fromId, toId);
    },

    VariableDeclarator(varPath) {
      if (!t.isIdentifier(varPath.node.id)) return;
      if (!isRequireCallExpression(varPath.node.init)) return;
      if (!t.isIdentifier(varPath.node.init.callee)) return;

      const requireName = varPath.node.init.callee.name;
      const requireMap = rewriteMaps.get(requireName);
      if (!requireMap) return;

      const fromId = getLiteralModuleId(varPath.node.init.arguments[0]);
      if (fromId == null) return;
      const toId = requireMap.get(fromId);
      if (!toId) return;

      const binding = varPath.scope.getBinding(varPath.node.id.name);
      if (!hasOnlyDefaultMemberUsages(binding)) return;

      varPath.node.init.arguments[0] = createModuleIdLiteral(varPath.node.init.arguments[0], toId);
      summary.rewrittenBindingInitializers += 1;
      noteRewrite(requireName, fromId, toId);
    }
  });

  summary.rewrittenTotal = summary.inlinedModuleBindings +
    summary.rewrittenDirectDefaultRequires + summary.rewrittenBindingInitializers;
  summary.rewritesTop = [...rewriteCounter.entries()]
    .map(([rule, count]) => {
      const [requireName, ids] = rule.split(':');
      const [fromId, toId] = ids.split('->');
      return { requireName, fromId, toId, rewrites: count };
    })
    .sort((a, b) => b.rewrites - a.rewrites)
    .slice(0, 200);

  return summary;
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

function isInRootBody(pathRef, rootPath) {
  const body = rootPath.node.body;
  if (!body || pathRef.node.start == null || body.start == null) return false;
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

function collectCandidates(ast, opts) {
  const scopeMap = new Map();

  traverse(ast, {
    StringLiteral(stringPath) {
      if (!opts.aliasStrings) return;
      if (isDirectiveString(stringPath) || isKeyPosition(stringPath) ||
          isStaticModuleSpecifier(stringPath) || isInsideJsx(stringPath)) return;

      const rootPath = getOutermostFunction(stringPath);
      if (!rootPath || !isInRootBody(stringPath, rootPath)) return;

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
      if (!rootPath || !isInRootBody(memberPath, rootPath)) return;

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
      if (!rootPath || !isInRootBody(memberPath, rootPath)) return;

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
      if (!opts.aliasGlobals) return;
      const name = identifierPath.node.name;
      if (!SAFE_GLOBALS.has(name)) return;
      if (identifierPath.scope.getBinding(name)) return;

      const rootPath = getOutermostFunction(identifierPath);
      if (!rootPath || !isInRootBody(identifierPath, rootPath)) return;

      const record = getScopeRecord(scopeMap, rootPath);
      addOccurrence(record, `g:${name}`, 'global', name, {
        kind: 'global',
        path: identifierPath,
        oldCost: name.length,
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
  if (!rootPath || !isInRootBody(propertyPath, rootPath)) return;

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
  return candidate.initKind === 'string'
    ? stringLiteralLength(candidate.value)
    : candidate.value.length;
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
    .filter((candidate) => candidate.initKind !== 'global' || !record.forbiddenGlobalWrites.has(candidate.value));

  // First rank by likely value, so a repeated long token is not excluded merely
  // because a short token occurs more often.
  candidates.forEach((candidate) => {
    const assumedAliasLength = 2;
    candidate.roughSaving = grossSaving(candidate, assumedAliasLength) -
      (assumedAliasLength + 1 + candidateInitLength(candidate) + 1);
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
      const declarationEntry = codeByteLength(candidate.alias) + 1 + candidateInitLength(candidate) + 1;
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
    const declarationEntry = codeByteLength(candidate.alias) + 1 + candidateInitLength(candidate) + 1;
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
      const init = candidate.initKind === 'string'
        ? t.stringLiteral(candidate.value)
        : t.identifier(candidate.value);
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

async function optimizeOnce(input, opts, beforeStats, stringArraysEnabled, webpackModuleExtraction) {
  const runOpts = { ...opts, stringArrays: stringArraysEnabled };
  const ast = parseCode(input, opts.inputFile);
  const report = {
    input: opts.inputFile,
    output: opts.outputFile,
    options: { ...runOpts, positional: undefined, inputFile: undefined, outputFile: undefined },
    webpackModuleExtraction,
    webpackImportOptimization: null,
    stringArrays: [],
    aliases: [],
    before: beforeStats,
    after: null,
    savings: null,
    arrayCompaction: null
  };

  compactStringArrays(ast, runOpts, report);
  report.webpackImportOptimization = optimizeWebpackImports(ast, webpackModuleExtraction);
  const scopeMap = collectCandidates(ast, runOpts);
  applyAliases(scopeMap, runOpts, report);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = fs.readFileSync(opts.inputFile, 'utf8');
  const beforeStats = byteStats(input);
  const webpackModuleExtraction = analyzeWebpackExtractableModules(parseCode(input, opts.inputFile));
  let chosen;

  if (opts.stringArrays) {
    const withArrays = await optimizeOnce(input, opts, beforeStats, true, webpackModuleExtraction);
    const withoutArrays = await optimizeOnce(input, opts, beforeStats, false, webpackModuleExtraction);
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
    chosen = await optimizeOnce(input, opts, beforeStats, false, webpackModuleExtraction);
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
  const extraction = report.webpackModuleExtraction;
  const extractionLine = extraction.detected
    ? `Webpack extractable modules: ${extraction.extractable.totalCandidates} (default-local: ${extraction.extractable.byType.defaultLocal}, default-reexport: ${extraction.extractable.byType.defaultReexport})`
    : 'Webpack extractable modules: 0 (webpack module map not detected)';
  const importOptimization = report.webpackImportOptimization || { rewrittenTotal: 0, mappingCount: 0 };
  const webpackImportLine = `Webpack import rewrites: ${importOptimization.rewrittenTotal} (mappings: ${importOptimization.mappingCount})`;
  process.stdout.write([
    `Wrote ${opts.outputFile}`,
    arrayLine,
    `Aliases inserted: ${report.aliases.length}`,
    extractionLine,
    webpackImportLine,
    `Raw:    ${beforeStats.raw} -> ${afterStats.raw}  saved ${report.savings.raw} (${percent(report.savings.raw, beforeStats.raw)})`,
    `Gzip:   ${beforeStats.gzip} -> ${afterStats.gzip}  saved ${report.savings.gzip} (${percent(report.savings.gzip, beforeStats.gzip)})`,
    `Brotli: ${beforeStats.brotli} -> ${afterStats.brotli}  saved ${report.savings.brotli} (${percent(report.savings.brotli, beforeStats.brotli)})`,
    ''
  ].join('\n'));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
