# Forno — Pizza Dough Calculator

Forno is a pizza dough calculator that models fermentation, flour strength,
and baking together, rather than treating baker's percentages as a static
table. Give it a proof temperature/time, a flour's protein and P/L, and an
oven setup, and it works out yeast (or levain) quantity, a hydration range,
a rise curve, a bake time and crust colour, and plain-language verdicts on
whether the recipe is under-, well-, or over-fermented. A flour analyser
takes the numbers off a bag or spec sheet and reads the flour back: what
it has going for it, where it's weak, and which styles it actually suits.

It's a single static page — open `index.html` and it runs, no build step,
no server.

## How it works

The app is built in three stages that feed one another:

1. **Ferment** — yeast quantity from a temperature/time "budget" using a
   Q₁₀ (~2.5) model anchored at 0.3% IDY / 8 h / 21°C, rendered as a
   modified-Gompertz rise curve.
2. **Flour** — protein % and P/L estimate a flour-strength (`W`) proxy,
   a workable hydration range, and how many hours the dough can ferment
   before it's pushed past its structural limit.
3. **Bake** — oven temperature and surface (steel/stone/pan/rack) drive
   bake time (inverse-exponential) and a crust-colour gauge, including a
   leoparding flag at the high-temp / short-time corner.

Alongside those, the **flour analyser** (the "Flour check" toggle) runs the
same models the other way round. You type in what the bag or spec sheet
prints — protein, and optionally W, P/L, water absorption, ash and falling
number — and it returns a profile, a per-finding list of strengths and
weaknesses, and a fit score against each built-in style naming
whichever dimension holds it back. Only protein is required: the rest is
estimated from what you give it and labelled as an estimate, and a printed
W or absorption overrides the estimate it would otherwise derive.

It reads both ways against the flour picker below. "Read protein from
above" seeds it from the bag you picked; "Use this flour above" pushes the
analysed protein and hydration back. Only protein makes that return trip
alongside hydration — the P/L slider is this app's own extensible↔elastic
scale rather than a printed ratio, so the analyser writes it only when the
bag actually stated a P/L, and otherwise leaves whatever the picked flour
set. Protein is passed through unrounded for the same reason: catalogue
flours carry off-grid figures like 12.7% and snapping them to the slider's
0.5 grid would turn a real bag into a different one.

Verdict-producing functions return `{ tone, code, params }` rather than
finished sentences, so the UI can translate them (English and German are
built in; `TRANSLATIONS` in `index.html` is where the string tables live).

Presets are included for Neapolitan, New York, Detroit, Roman al taglio,
and sourdough styles, each with style guidelines (protein, hydration,
salt, prove temp/time, oven) to check a recipe against.

## Saving and sharing

Everything the app remembers lives in the browser. There is no account and
no server — the page is static, so there is nowhere for a dough to go.

**Share links** put the whole setup in the URL itself. The app already
persists its state as query params, so `shareLink.js` takes that query
string wholesale — version, length, UTF-8 bytes, a salted XOR scramble and
an FNV-1a checksum, base64url'd — and hangs the result off the hash
(`#d=…`), where it never reaches a server log. Wrapping the query string
rather than a field schema makes the token lossless for hand-typed values
and automatically complete for every control, present and future. The link
still reads as a random slug: the scramble differs every time, and short
payloads are padded so a near-default dough doesn't stand out.

A recipe's name rides along as one more param inside that same opaque
token, so a shared dough can arrive under the name its author gave it
without the name appearing in the link. It isn't app config, so `index.html`
lifts it back out before the config hooks — or the address bar — see it,
and then offers to save the dough. An incoming link never writes to your
box on its own.

**The recipe box** (`recipeStore.js`) is one versioned `localStorage` key
holding three things:

- **recipes** — doughs you saved, whether you built them or a link brought
  them in. One can be marked as the dough the app opens on.
- **flours** — bags you own, by name plus protein and P/L, on top of a
  built-in catalogue of common Italian, North American and German flours.
  Those two sliders are the hardest numbers to guess, and they're a
  property of the bag, not of the recipe. Catalogue figures are the usual
  published/label values; every harvest differs, so they're a starting
  point, not a spec.
- **kitchen** — oven, surface, room temperature, target dough temperature
  and mixing method: properties of where you bake rather than of any one
  recipe, so the app can open with them.

Anything arriving from outside — a hand-edited storage blob, an imported
backup, a dough that came in on a link — is checked against
`sanitizeInputs` in `doughEngine.js`, which is the single definition of a
legal dough (every field, its range, and the query param it persists
under), and dropped if it doesn't fit. Since the browser is the only copy,
the box exports to and imports from a plain JSON file.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | The app: markup, styles, and the React (via in-browser Babel) UI. Loads `doughEngine.js`, `shareLink.js` and `recipeStore.js` before its own script block and reads them off `window.DoughEngine` / `window.ShareLink` / `window.RecipeStore`. |
| `doughEngine.js` | The calculation engine — single source of truth for the dough math, the preset data (styles, ovens, flours), and the input contract (`DOUGH_RANGES`/`DOUGH_ENUMS`/`DOUGH_PARAMS` and `sanitizeInputs`). Wrapped in an IIFE, exported for both Node (`module.exports`) and the browser (`window.DoughEngine`) so the same code backs the UI and the tests. |
| `doughEngine.test.js` | Unit tests for the engine, using Node's built-in test runner. |
| `shareLink.js` | Share links: wraps the config-in-URL query string in one opaque, URL-safe token, and expands an incoming token back into query params. |
| `shareLink.test.js` | Unit tests for token encoding, decoding and validation. |
| `recipeStore.js` | The recipe box — saved doughs, the flour shelf and the kitchen profile, in `localStorage` under one versioned key. Takes any `getItem`/`setItem`/`removeItem` object, so it's testable without a browser. |
| `recipeStore.test.js` | Unit tests for the box, against a fake storage. |
| `wrangler.jsonc` | Cloudflare Workers/Pages config for deploying the static site. |
| `.github/workflows/test.yml` | CI: runs all three test suites on every push/PR. |
| `.github/workflows/pages.yml` | Deploys `index.html` and friends to GitHub Pages. |
| `SOURCES.md` | The research and articles the fermentation/flour/baking heuristics draw on (mirrors the in-app Sources panel). |

No `package.json`, no bundler — React and Babel are loaded from a CDN at
runtime, and Node's built-in test runner covers the engine, the share links
and the recipe box.

## Running it

Open `index.html` directly in a browser, or serve the directory statically:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Testing

```sh
node --test doughEngine.test.js shareLink.test.js recipeStore.test.js
```

Requires Node 18+ (uses the built-in `node:test` runner — no dependencies
to install).

## Deployment

- **GitHub Pages**: `.github/workflows/pages.yml` deploys the repo root on
  push to its configured branch, or via manual dispatch.
- **Cloudflare**: `wrangler.jsonc` serves the repo root as static assets
  (`wrangler deploy`).

## Sources

The fermentation, flour/gluten, salt/rheology, over-fermentation, and
baking/storage heuristics are informed by peer-reviewed research and
practitioner write-ups, listed in the app's own "Sources" panel and
mirrored in [`SOURCES.md`](./SOURCES.md). Peer-reviewed work is
paraphrased into this tool's heuristics, not implemented from the original
methods.
