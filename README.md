# JS Extra Compressor

An AST-based post-processing pass for already-minified JavaScript bundles.

It performs two transformations:

1. Replaces repeated string literals, property/method names, and selected built-in globals with collision-free aliases inserted inside an existing function scope.
2. Rewrites profitable arrays containing only strings from `['A','B',...]` to `'A!B!...'.split('!')` using a delimiter absent from every element.

It intentionally does **not** insert declarations at program/global scope. Program-level occurrences are skipped. Existing top-level functions (common in UMD/Webpack bundles) are used as private alias scopes.

## Install

```bash
npm install
```

## Run

```bash
node extra-compress.js input.js output.js --report report.json
```

Example with stricter thresholds:

```bash
node extra-compress.js input.js output.js \
  --min-occurrences 6 \
  --min-saving 4 \
  --array-min-items 8 \
  --array-min-saving 2 \
  --report report.json
```

The CLI prints raw, gzip, and Brotli sizes. Raw output can shrink while gzip/Brotli gets slightly larger because those formats already deduplicate repeated text. Always compare the metric that matters for deployment.

## Safety boundaries

- Parsing and rewriting are AST-based; comments and license comments beginning with `/*!` are preserved.
- Alias identifiers are chosen so they do not collide with any identifier inside the containing function subtree.
- Directives, static import/export specifiers, JSX strings, `constructor`, shorthand properties, and the special `__proto__` object-literal key are not rewritten.
- Local identifiers such as `exports` are not aliased: they can be reassigned or shadowed, so replacing them with a snapshot would not be generally semantics-preserving.
- Built-in global aliasing snapshots values such as `Object` at function entry. Disable it with `--no-alias-globals` when code intentionally replaces built-ins at runtime.
- The array rewrite adds a small startup cost because `.split()` runs at load time.

Run your normal unit, integration, and browser tests on the transformed bundle before deploying it.
