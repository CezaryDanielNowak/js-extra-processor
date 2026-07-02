# Extra JavaScript Compressor

> Because apparently UglifyJS did not suffer enough.

A small Node.js post-processing tool for squeezing a little more out of JavaScript that has already been bundled or minified.

It is designed to work **after UglifyJS**, not start a turf war with it. UglifyJS performs general-purpose compression, mangling, dead-code removal, and syntax optimization. This tool applies additional bundle-level transformations that may still be profitable after normal minification.

## Why this exists

Sometimes a large production bundle goes through a bundler, UglifyJS, gzip, Brotli, three code reviews, and a small ritual sacrifice—and still contains suspiciously repetitive strings.

This tool is the final pass for that situation.

It is intentionally a **semi-private utility**, not a polished general-purpose minifier. The goals are simple:

- save bytes where the transformation is measurable;
- stay out of the global scope;
- avoid heroic rewrites;
- produce a report so nobody has to trust vibes.

## Real-life gains
Measured on 2026-07-02 using widget-v1-en-before.js with string-array compaction enabled.

Example input file: 1 860 426 bytes

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 160 938 bytes / 8.651% | 6 299 bytes / 1.239% | 1 873 bytes / 0.472% |
| 120 | 178 100 bytes / 9.573% | 6 928 bytes / 1.362% | 2 201 bytes / 0.555% |
| 160 | 191 650 bytes / 10.301% | 7 344 bytes / 1.444% | 2 152 bytes / 0.543% |
| 200 | 202 968 bytes / 10.910% | 7 820 bytes / 1.538% | 2 365 bytes / 0.597% |
| 240 | 212 409 bytes / 11.417% | 8 250 bytes / 1.622% | 2 144 bytes / 0.541% |

Webpack extraction and import optimization on the same bundle (default run):

- Extractable candidates: 8 modules
- Candidate types: 8 default-local, 0 default-reexport
- Estimated wrapper bytes in those candidates: 14 723 bytes
- Webpack import rewrites applied: 8 (8 single-use module bindings inlined)

## Quick start

```bash
npx uglify-js dist/widget.js   --compress   --mangle   --output dist/widget.uglify.min.js

node extra-compress.js   dist/widget.uglify.min.js   dist/widget.min.js   --no-string-arrays   --report dist/widget-report.json
```

That is the usual setup: **UglifyJS first, extra compressor second**.

## What it actually does

The compressor currently knows two useful tricks:

1. **Aliases repeated strings, property names, and safe global objects**
2. **Compacts large arrays of strings using a joined string and `.split()`**

It evaluates estimated byte savings before applying aliases and validates that the generated output is still valid JavaScript before writing it.

## Tiny example, big ambitions

Repeated values such as:

```js
Object.defineProperty(exports, "__esModule", {
  value: true
});

component.componentDidMount();
component.componentWillUnmount();
component.render();
```

may be transformed into code conceptually similar to:

```js
const a = Object;
const b = "defineProperty";
const c = "exports";
const d = "__esModule";
const e = "componentDidMount";
const f = "componentWillUnmount";
const g = "render";

a[b][c];
```

The real output is generated from the JavaScript AST and uses short, collision-free variable names. No regex archaeology involved.

The aliases are inserted only inside an existing outer function scope. The tool intentionally does not add variables to the global scope.

## String-array compaction: the `.split()` trick

A long array containing only strings can be rewritten from:

```js
const VALUES = [
  "VERSION",
  "SHADING_LANGUAGE_VERSION",
  "MAX_VERTEX_ATTRIBS",
  "MAX_VERTEX_UNIFORM_VECTORS"
];
```

to:

```js
const VALUES =
  "VERSION!SHADING_LANGUAGE_VERSION!MAX_VERTEX_ATTRIBS!MAX_VERTEX_UNIFORM_VECTORS"
    .split("!");
```

The tool automatically chooses a delimiter that does not occur in any array item and applies the transformation only when it reduces the raw output size by the configured minimum.

## Working together with UglifyJS

The recommended assembly line is:

```text
source code
    ↓
bundler
    ↓
UglifyJS
    ↓
Extra JavaScript Compressor
    ↓
gzip or Brotli
```

## License

This is a semi-private project, so use whatever project-internal license rules apply. Still, preserve third-party license comments from the original bundle where required.


