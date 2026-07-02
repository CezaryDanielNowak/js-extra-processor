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
Example input file: 1 860 426 bytes

Measured on `widget-v1-en-before.js` with current code.

### With string-array compaction

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 160 898 bytes / 8.648% | 6 298 bytes / 1.238% | 2 233 bytes / 0.563% |
| 120 | 178 060 bytes / 9.571% | 6 929 bytes / 1.363% | 2 271 bytes / 0.573% |
| 160 | 191 610 bytes / 10.299% | 7 347 bytes / 1.445% | 2 392 bytes / 0.603% |
| 200 | 202 928 bytes / 10.908% | 7 822 bytes / 1.538% | 2 357 bytes / 0.595% |
| 240 | 212 369 bytes / 11.415% | 8 253 bytes / 1.623% | 2 465 bytes / 0.622% |

### With `--no-string-arrays`

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 159 566 bytes / 8.577% | 6 708 bytes / 1.319% | 2 208 bytes / 0.557% |
| 120 | 176 966 bytes / 9.512% | 7 471 bytes / 1.469% | 2 459 bytes / 0.620% |
| 160 | 190 640 bytes / 10.247% | 7 620 bytes / 1.498% | 2 439 bytes / 0.615% |
| 200 | 202 052 bytes / 10.861% | 8 174 bytes / 1.607% | 2 575 bytes / 0.650% |
| 240 | 211 624 bytes / 11.375% | 8 500 bytes / 1.671% | 2 343 bytes / 0.591% |

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


