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
  '!', '|', '~', '^', '@', '#', '%', '&', '*', ';', ':', ',', '?', '/',
  '\\', '+', '=', '-', '_', '.', '§', '¶', '¦', '¬', '·'
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
  --array-min-saving <n>  Minimum raw-byte saving for an array rewrite (default: 1)
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
    arrayMinSaving: 1,
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
    else if (arg === '--array-min-items') opts.arrayMinItems = readInt(argv, ++i, arg, 2);
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
    // High-frequency candidates get the shortest collision-free identifiers.
    candidates.sort((a, b) => b.occurrences.length - a.occurrences.length ||
      b.roughSaving - a.roughSaving);
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
  candidates.sort((a, b) => b.occurrences.length - a.occurrences.length ||
    b.estimatedSaving - a.estimatedSaving);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = fs.readFileSync(opts.inputFile, 'utf8');
  const beforeStats = byteStats(input);
  const ast = parseCode(input, opts.inputFile);
  const report = {
    input: opts.inputFile,
    output: opts.outputFile,
    options: { ...opts, positional: undefined, inputFile: undefined, outputFile: undefined },
    stringArrays: [],
    aliases: [],
    before: beforeStats,
    after: null,
    savings: null
  };

  compactStringArrays(ast, opts, report);
  const scopeMap = collectCandidates(ast, opts);
  applyAliases(scopeMap, opts, report);
  const output = await printCode(ast, opts);

  // Final parser pass catches accidental invalid output before writing it.
  parseCode(output, opts.outputFile);
  fs.writeFileSync(opts.outputFile, output);

  const afterStats = byteStats(output);
  report.after = afterStats;
  report.savings = {
    raw: beforeStats.raw - afterStats.raw,
    gzip: beforeStats.gzip - afterStats.gzip,
    brotli: beforeStats.brotli - afterStats.brotli
  };

  if (opts.reportFile) {
    fs.writeFileSync(path.resolve(opts.reportFile), `${JSON.stringify(report, null, 2)}\n`);
  }

  const percent = (saved, original) => `${((saved / original) * 100).toFixed(3)}%`;
  process.stdout.write([
    `Wrote ${opts.outputFile}`,
    `String arrays compacted: ${report.stringArrays.length}`,
    `Aliases inserted: ${report.aliases.length}`,
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
