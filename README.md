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

All values in these tables are measured with default options (instanceof helper disabled, object-array unpacking disabled unless explicitly enabled).

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

### With all features enabled

| max-aliases | Raw saving | Gzip saving | Brotli saving |
| --- | --- | --- | --- |
| 80  | 183 275 bytes / 9.851% | 6 874 bytes / 1.352% | 2 529 bytes / 0.638% |
| 120 | 200 655 bytes / 10.785% | 7 612 bytes / 1.497% | 2 538 bytes / 0.640% |
| 160 | 214 330 bytes / 11.520% | 8 082 bytes / 1.589% | 2 728 bytes / 0.688% |
| 200 | 225 747 bytes / 12.134% | 8 763 bytes / 1.723% | 2 797 bytes / 0.706% |
| 240 | 235 274 bytes / 12.646% | 8 913 bytes / 1.753% | 2 643 bytes / 0.667% |

Defaults are configured for brotli savings. All features enabled will make raw file smaller, but no gain for brotli. Results might be different for your file.

## Quick start

```bash
npx uglify-js dist/widget.js   --compress   --mangle   --output dist/widget.uglify.min.js

node extra-compress.js   dist/widget.uglify.min.js   dist/widget.min.js   --no-string-arrays   --report dist/widget-report.json
```

That is the usual setup: **UglifyJS first, extra compressor second**.

## What it actually does

The compressor currently applies seven optimization points:

1. **Alias repeated strings, property names, and safe global objects**
2. **Compact large string arrays using a joined string and `.split()`**
3. **Rewrite selected string concatenations into template literals (guarded by compressed-size checks)**
4. **Rewrite repeated-key object arrays to an unpacking helper call (opt-in via `--object-unpacking`)**
5. **Rewrite `x instanceof X` to a short helper call (opt-in via `--instanceof-helper`)**
6. **Alias repeated `undefined` and `void 0` values (disable with `--no-alias-undefined`)**
7. **Collapse repeated `"use strict"` directives into one top-level directive (opt-in via `--assume-strict`)**

It evaluates estimated byte savings before applying aliases and validates that the generated output is still valid JavaScript before writing it.

### 1. Alias repeated strings, property names, and safe global objects

Before:

```js
Object.defineProperty(exports, "__esModule", { value: true });
component.componentDidMount();
component.componentWillUnmount();
component.render();
```

After:

```js
const a = Object;
const b = "defineProperty";
const c = "__esModule";
const d = "componentDidMount";
const e = "componentWillUnmount";
const f = "render";

a[b](exports, c, { value: true });
component[d]();
component[e]();
component[f]();
```

Aliases are inserted only inside an existing outer function scope. The tool intentionally does not add variables to the global scope.

### 2. Compact large string arrays using `.split()`

Before:

```js
const VALUES = [
  "VERSION",
  "SHADING_LANGUAGE_VERSION",
  "MAX_VERTEX_ATTRIBS",
  "MAX_VERTEX_UNIFORM_VECTORS"
];
```

After:

```js
const VALUES =
  "VERSION!SHADING_LANGUAGE_VERSION!MAX_VERTEX_ATTRIBS!MAX_VERTEX_UNIFORM_VECTORS"
    .split("!");
```

The delimiter is chosen automatically so it does not appear in any array item.

### 3. Rewrite selected string concatenations into template literals

Before:

```js
const message = "User " + id + " has " + count + " items.";
const message2 = "User " + nextId + " has " + count + " items.";
```

After:

```js
const message = `User ${id} has ${count} items.`;
const message2 = `User ${nextId} has ${count} items.`;
```

This rewrite is guarded by compressed-size checks, so it is kept only when gzip/brotli results stay favorable.

### 4. Rewrite repeated-key object arrays to an unpacking helper call (opt-in)

Object-array unpacking is disabled by default. Enable it with `--object-unpacking`.

Before:

```js
const rows = [
  { index: 7, amount: 15 },
  { index: 6, amount: 25 },
  { index: 5, amount: 30 }
];
```

After:

```js
const $ = (values, ...keys) =>
  values.reduce((out, value, i) => {
    i % keys.length || out.push({});
    out[out.length - 1][keys[i % keys.length]] = value;
    return out;
  }, []);

const rows = $([7, 15, 6, 25, 5, 30], "index", "amount");
```

The helper name is generated dynamically with collision checks and kept as short as possible.

Note: for my bundles, RAW saving was significant but Brotli result could be significantly worse, so keep this mode opt-in.

### 5. Rewrite `x instanceof X` to a helper call

This optimization is disabled by default; enable it with `--instanceof-helper`.

Before:

```js
const a = value instanceof TypeA;
const b = value2 instanceof TypeB;
```

After:

```js
const $ = (v, C) => v instanceof C;
const a = $(value, TypeA);
const b = $(value2, TypeB);
```

The helper name is generated dynamically, kept short, and collision-safe inside each function scope.

### 6. Alias repeated `undefined` and `void 0` values

Before:

```js
const a = undefined;
const b = void 0;
const c = undefined;
const d = void 0;
```

After:

```js
const a = void 0;
const b = a;
const c = a;
const d = a;
```

This optimization is enabled by default; disable it with `--no-alias-undefined`.

### 7. Collapse repeated `"use strict"` directives (opt-in)

Before:

```js
"use strict";
function first(v) {
  "use strict";
  return v + 1;
}
function second(v) {
  "use strict";
  return first(v) + 1;
}
```

After:

```js
"use strict";
function first(v) {
  return v + 1;
}
function second(v) {
  return first(v) + 1;
}
```

Use `--assume-strict` only when your bundle is strict-safe.

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


