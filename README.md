# Forno — Pizza Dough Calculator

Forno is a pizza dough calculator that models fermentation, flour strength,
and baking together, rather than treating baker's percentages as a static
table. Give it a proof temperature/time, a flour's protein and P/L, and an
oven setup, and it works out yeast (or levain) quantity, a hydration range,
a rise curve, a bake time and crust colour, and plain-language verdicts on
whether the recipe is under-, well-, or over-fermented.

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

Verdict-producing functions return `{ tone, code, params }` rather than
finished sentences, so the UI can translate them (English and German are
built in; `TRANSLATIONS` in `index.html` is where the string tables live).

Presets are included for Neapolitan, New York, Detroit, Roman al taglio,
and sourdough styles, each with style guidelines (protein, hydration,
salt, prove temp/time, oven) to check a recipe against.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | The app: markup, styles, and the React (via in-browser Babel) UI. Loads `doughEngine.js` before its own script block and destructures the calculation functions off `window.DoughEngine`. |
| `doughEngine.js` | The calculation engine — single source of truth for the dough math. Wrapped in an IIFE, exported for both Node (`module.exports`) and the browser (`window.DoughEngine`) so the same code backs the UI and the tests. |
| `doughEngine.test.js` | Unit tests for the engine, using Node's built-in test runner. |
| `wrangler.jsonc` | Cloudflare Workers/Pages config for deploying the static site. |
| `.github/workflows/test.yml` | CI: runs the engine tests on every push/PR. |
| `.github/workflows/pages.yml` | Deploys `index.html` and friends to GitHub Pages. |
| `SOURCES.md` | The research and articles the fermentation/flour/baking heuristics draw on (mirrors the in-app Sources panel). |

No `package.json`, no bundler — React and Babel are loaded from a CDN at
runtime, and Node's built-in test runner covers the engine.

## Running it

Open `index.html` directly in a browser, or serve the directory statically:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Testing

```sh
node --test doughEngine.test.js
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
