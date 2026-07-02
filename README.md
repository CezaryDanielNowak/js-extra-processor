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
Updated after benchmark runs.

### With string-array compaction

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 167 910 bytes / 9.025% | 6 645 bytes / 1.307% | 2 460 bytes / 0.621% |
| 120 | 185 270 bytes / 9.958% | 7 155 bytes / 1.407% | 2 665 bytes / 0.672% |
| 160 | 198 846 bytes / 10.688% | 7 665 bytes / 1.507% | 2 816 bytes / 0.710% |
| 200 | 210 210 bytes / 11.299% | 8 178 bytes / 1.608% | 2 623 bytes / 0.662% |
| 240 | 219 710 bytes / 11.810% | 8 589 bytes / 1.689% | 2 450 bytes / 0.618% |

### With `--no-string-arrays`

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 166 576 bytes / 8.954% | 7 023 bytes / 1.381% | 2 668 bytes / 0.673% |
| 120 | 184 127 bytes / 9.897% | 7 829 bytes / 1.540% | 2 888 bytes / 0.729% |
| 160 | 197 870 bytes / 10.636% | 8 000 bytes / 1.573% | 2 660 bytes / 0.671% |
| 200 | 209 361 bytes / 11.253% | 8 443 bytes / 1.660% | 2 849 bytes / 0.719% |
| 240 | 218 938 bytes / 11.768% | 8 918 bytes / 1.754% | 2 953 bytes / 0.745% |

## Quick start

```bash
npx uglify-js dist/widget.js   --compress   --mangle   --output dist/widget.uglify.min.js

node extra-compress.js   dist/widget.uglify.min.js   dist/widget.min.js   --no-string-arrays   --report dist/widget-report.json
```

That is the usual setup: **UglifyJS first, extra compressor second**.

## What it actually does

The compressor currently knows three useful tricks:

1. **Aliases repeated strings, property names, and safe global objects**
2. **Compacts large arrays of strings using a joined string and `.split()`**
3. **Rewrites some string concatenations into template literals when that is shorter, then keeps the rewrite only when compressed output stays favorable**

It can also alias repeated `undefined` and `void 0` values by default; disable with `--no-alias-undefined`.

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


