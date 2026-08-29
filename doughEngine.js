// Pizza dough calculation engine — single source of truth.
//
// Loaded two ways:
//   - Node (tests):   require('./doughEngine.js')
//   - Browser (app):  <script src="doughEngine.js"> before index.html's babel
//                     block, which reads these off window.DoughEngine.
//
// Verdict-style functions return { tone, code, params } rather than finished
// prose so the UI can translate them; see TRANSLATIONS in index.html.


// Wrapped in an IIFE so its internals stay off the global scope — index.html
// destructures the same names from window.DoughEngine in the page's own scope.
(function () {
'use strict';

/* ------------------------------------------------------------------ *
 *  Dough calculator — three stages
 *  1. Ferment: yeast from a temperature/time "budget" (Q10); modified
 *     Gompertz rise curve coloured along a cold->warm axis
 *  2. Flour: protein -> W estimate, hydration range, ferment capacity;
 *     weak flour over-fermented visibly collapses
 *  3. Bake: oven temp -> bake time (exponential), crust-colour gauge,
 *     leoparding flag at the high-temp / short-time corner
 * ------------------------------------------------------------------ */

const REF = { yeastPct: 0.3, hours: 8, tempC: 21 }; // IDY anchor
const K = REF.yeastPct * REF.hours; // 2.4 (%·h) at 21°C
const Q10 = 2.5;
const SALT_REF = 2.5; // salt % at which the fermentation anchor was set
const TYPE = {
  idy: { label: "Instant dry", mult: 1.0, gPerTsp: 3.15 },
  ady: { label: "Active dry", mult: 1.33, gPerTsp: 3.1 },
  fresh: { label: "Fresh / cake", mult: 3.0, gPerTsp: null },
};
const V_AXIS = 260;
const EMBER = "#C25A33"; // heat accent for the bake stage
const SURF = {
  steel: { label: "Steel", k: 1.0 },
  stone: { label: "Stone", k: 0.8 },
  pan: { label: "Pan", k: 0.55 },
  rack: { label: "Rack", k: 0.3 },
};
const FRICTION = {
  hand: { label: "By hand", f: 2 },
  mixer: { label: "Stand mixer", f: 8 },
  processor: { label: "Processor", f: 14 },
};
const CONF = { g: "#4F6E37", h: "#D99B36", i: "#9b8aa3" }; // grounded / heuristic / illustrative

// architecture as a layered DAG: inputs -> models -> outputs
const GRAPH = {
  cols: [
    [
      ["i_prove", "Temp · Time"],
      ["i_flour", "Protein · P/L"],
      ["i_pct", "Hydr·Salt·Oil·Sugar"],
      ["i_leaven", "Leaven · Preferment"],
      ["i_mix", "Room · FDT · Method"],
      ["i_batch", "Dough weight"],
      ["i_bake", "Oven · Surface"],
    ],
    [
      ["m_yeast", "Q₁₀ yeast / levain", "g"],
      ["m_weights", "Baker's % weights", "g"],
      ["m_water", "Water temp", "g"],
      ["m_flour", "Flour profile", "h"],
      ["m_rise", "Gompertz + proof", "h"],
      ["m_bake", "Bake (time·colour)", "h"],
      ["m_digest", "Digestibility", "i"],
      ["m_geom", "Crumb/pizza geom", "h"],
    ],
    [
      ["o_yeast", "Yeast / levain g", "g"],
      ["o_recipe", "Recipe", "g"],
      ["o_curve", "Rise curve", "h"],
      ["o_crumb", "Crumb SVG", "h"],
      ["o_pizza", "Pizza SVG", "h"],
      ["o_bake", "Bake readout", "h"],
      ["o_verdict", "Verdicts", "h"],
    ],
  ],
  edges: [
    ["i_prove", "m_yeast", "g"], ["i_prove", "m_rise", "h"], ["i_prove", "m_digest", "i"],
    ["i_flour", "m_flour", "h"], ["i_flour", "m_rise", "h"], ["i_flour", "m_geom", "h"],
    ["i_pct", "m_weights", "g"], ["i_pct", "m_yeast", "g"], ["i_pct", "m_bake", "h"], ["i_pct", "m_flour", "h"],
    ["i_leaven", "m_yeast", "g"], ["i_leaven", "m_digest", "i"],
    ["i_mix", "m_water", "g"],
    ["i_batch", "m_weights", "g"],
    ["i_bake", "m_bake", "h"], ["i_bake", "m_geom", "h"],
    ["m_yeast", "o_yeast", "g"], ["m_yeast", "o_recipe", "g"],
    ["m_weights", "o_recipe", "g"], ["m_weights", "o_yeast", "g"],
    ["m_water", "o_recipe", "g"],
    ["m_flour", "o_verdict", "h"], ["m_flour", "o_crumb", "h"],
    ["m_rise", "o_curve", "h"], ["m_rise", "o_crumb", "h"], ["m_rise", "o_pizza", "h"],
    ["m_bake", "o_bake", "h"], ["m_bake", "o_crumb", "h"], ["m_bake", "o_pizza", "h"],
    ["m_digest", "o_verdict", "i"],
    ["m_geom", "o_crumb", "h"], ["m_geom", "o_pizza", "h"],
  ],
};
const DG = { W: 760, H: 384, colX: [8, 300, 620], colW: [152, 180, 132], top: 30, nodeH: 26 };

const PIZZA_PRESETS = [
  { id: "neapolitan", label: "Neapolitan", set: { tempC: 18, hours: 24, protein: 13, plVal: 55, hydration: 60, salt: 2.8, oilPct: 0, sugarPct: 0, leavening: "commercial", preferment: "biga", ovenC: 460, surface: "stone", ddt: 23 } },
  { id: "ny", label: "New York", set: { tempC: 4, hours: 48, protein: 13, plVal: 50, hydration: 63, salt: 2, oilPct: 2.5, sugarPct: 1, leavening: "commercial", preferment: "straight", ovenC: 300, surface: "steel", ddt: 24 } },
  { id: "detroit", label: "Detroit", set: { tempC: 20, hours: 6, protein: 13, plVal: 45, hydration: 70, salt: 2, oilPct: 1, sugarPct: 0, leavening: "commercial", preferment: "straight", ovenC: 280, surface: "pan", ddt: 25 } },
  { id: "roman", label: "Roman al taglio", set: { tempC: 4, hours: 48, protein: 12.5, plVal: 40, hydration: 80, salt: 2.2, oilPct: 2, sugarPct: 0, leavening: "commercial", preferment: "poolish", ovenC: 290, surface: "steel", ddt: 23 } },
  { id: "sourdough", label: "Sourdough", set: { tempC: 5, hours: 24, protein: 12.5, plVal: 50, hydration: 72, salt: 2.5, oilPct: 0, sugarPct: 0, leavening: "sourdough", preferment: "straight", ovenC: 270, surface: "steel", ddt: 24, starterStr: 60 } },
];
const OVEN_PRESETS = [
  { id: "home", label: "Home oven", set: { ovenC: 250, surface: "steel" } },
  { id: "homehot", label: "Home + stone", set: { ovenC: 300, surface: "stone" } },
  { id: "deck", label: "Deck oven", set: { ovenC: 330, surface: "stone" } },
  { id: "electric", label: "Electric pizza", set: { ovenC: 440, surface: "stone" } },
  { id: "wood", label: "Wood-fired", set: { ovenC: 490, surface: "stone" } },
];

// A shelf of flours people actually buy, so protein and P/L stop being two
// blind sliders: pick the bag, get the numbers. `protein` is the label /
// published figure and `plVal` is this app's 0-100 extensible↔elastic
// slider (50 = balanced), *not* a literal P/L ratio — the real ratio, where
// the miller publishes one, is in `spec`. Every bag varies by harvest and
// mill run, so these are starting points; the sliders stay editable and a
// tweaked flour can be saved to the user's own shelf (see recipeStore.js).
// German Type numbers grade ash content, not protein, so their protein
// figures here are the usual range for that grade rather than a spec.
const FLOUR_PRESETS = [
  // --- Italian 00 / pizza flours ---
  { id: "caputo-pizzeria",  label: "Caputo Pizzeria",         region: "it", protein: 12.5, plVal: 50, spec: "00 · W 260–270 · P/L 0.50–0.60" },
  { id: "caputo-cuoco",     label: "Caputo Cuoco",            region: "it", protein: 13.0, plVal: 55, spec: "00 · W 300–320 · P/L 0.50–0.60" },
  { id: "caputo-nuvola",    label: "Caputo Nuvola",           region: "it", protein: 12.5, plVal: 45, spec: "00 · W 260–270 · airier rim" },
  { id: "caputo-manitoba",  label: "Caputo Manitoba Oro",     region: "it", protein: 14.5, plVal: 65, spec: "0 · W 380–400 · blending flour" },
  { id: "cinque-stagioni",  label: "Le 5 Stagioni Napoletana", region: "it", protein: 12.5, plVal: 50, spec: "00 · W 250–270" },
  { id: "polselli-super",   label: "Polselli Super",          region: "it", protein: 13.5, plVal: 55, spec: "00 · W ~330" },
  // --- North American ---
  { id: "gold-medal-ap",    label: "Gold Medal All-Purpose",  region: "us", protein: 10.5, plVal: 45, spec: "10.5% protein · soft" },
  { id: "ka-ap",            label: "King Arthur All-Purpose", region: "us", protein: 11.7, plVal: 45, spec: "11.7% protein · unbleached" },
  { id: "ka-bread",         label: "King Arthur Bread Flour", region: "us", protein: 12.7, plVal: 55, spec: "12.7% protein · unbleached" },
  { id: "all-trumps",       label: "General Mills All Trumps", region: "us", protein: 14.2, plVal: 65, spec: "high-gluten · NY-slice standard" },
  { id: "ka-lancelot",      label: "King Arthur Sir Lancelot", region: "us", protein: 14.2, plVal: 65, spec: "high-gluten · 14.2% protein" },
  // --- German / Austrian Type grades ---
  { id: "type-405",         label: "Weizenmehl Type 405",     region: "de", protein: 10.0, plVal: 40, spec: "soft · cakes, same-day doughs" },
  { id: "type-550",         label: "Weizenmehl Type 550",     region: "de", protein: 11.5, plVal: 50, spec: "the standard German pizza flour" },
  { id: "type-812",         label: "Weizenmehl Type 812",     region: "de", protein: 12.0, plVal: 55, spec: "darker, a touch stronger" },
  { id: "type-1050",        label: "Weizenmehl Type 1050",    region: "de", protein: 12.5, plVal: 60, spec: "high-extraction · more bran" },
  // --- generic descriptions, for bags with no published spec ---
  { id: "uk-plain",         label: "Plain / plain white flour", region: "generic", protein: 9.5,  plVal: 40, spec: "soft · struggles past ~12 h" },
  { id: "uk-strong",        label: "Strong white bread flour", region: "generic", protein: 12.5, plVal: 55, spec: "typical supermarket bread flour" },
  { id: "manitoba",         label: "Manitoba (generic)",      region: "generic", protein: 14.5, plVal: 70, spec: "W 380+ · very strong" },
];
const FLOUR_REGIONS = ["it", "us", "de", "generic"];

// ---- the dough input contract ----------------------------------------
// What `computeAll` will accept: every field, its legal range, and the
// query param the UI persists it under. The engine consumes these inputs,
// so it's the engine that says what a legal dough is — the recipe box
// checks a stored or imported dough against exactly this, rather than
// keeping a second opinion of its own.
//
// Ranges mirror the slider bounds in index.html; typed entry is clamped to
// the same bounds, so anything inside a range is a value the UI can hold.
const DOUGH_RANGES = {
  tempC: [2, 35], hours: [2, 96], protein: [8, 15], plVal: [0, 100],
  hydration: [50, 85], salt: [0, 4], oilPct: [0, 6], sugarPct: [0, 4],
  starterStr: [0, 100], ballCount: [1, 12], ballWeight: [100, 500],
  roomTemp: [12, 30], ddt: [20, 28], ovenC: [200, 500],
};

const DOUGH_ENUMS = {
  leavening:  ["commercial", "sourdough"],
  yeastType:  ["idy", "ady", "fresh"],
  preferment: ["straight", "poolish", "biga"],
  mixMethod:  ["hand", "mixer", "processor"],
  surface:    ["steel", "stone", "pan", "rack"],
};

// field -> the query param index.html's useConfigX hooks keep it under.
const DOUGH_PARAMS = {
  tempC: "tempC", hours: "hours", protein: "protein", plVal: "pl",
  hydration: "hydration", salt: "salt", oilPct: "oil", sugarPct: "sugar",
  yeastType: "yeast", leavening: "leaven", starterStr: "starter",
  preferment: "preferment", ballCount: "balls", ballWeight: "ballWeight",
  roomTemp: "room", ddt: "ddt", mixMethod: "mix", ovenC: "oven", surface: "surface",
};

// Returns a fresh object holding exactly the known fields, or null if any
// is missing, non-finite, out of range, or not one of the enum's values.
// Numeric strings are accepted, since that's how values arrive from a query
// string. Rounding is to 4 decimals — enough to absorb float noise without
// flattening a hand-typed 62.75%.
function sanitizeInputs(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const key in DOUGH_RANGES) {
    const [lo, hi] = DOUGH_RANGES[key];
    const raw = obj[key];
    if (raw === "" || raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo - 1e-9 || n > hi + 1e-9) return null;
    out[key] = Math.round(n * 10000) / 10000;
  }
  for (const key in DOUGH_ENUMS) {
    if (!DOUGH_ENUMS[key].includes(obj[key])) return null;
    out[key] = obj[key];
  }
  return out;
}

const STYLE_GUIDELINES = {
  neapolitan: [
    { key:"protein",   label:"Protein",    lo:12.5, hi:13.5, unit:"%",  note:"00 flour, W 280–320" },
    { key:"hydration", label:"Hydration",  lo:58,   hi:65,   unit:"%",  note:"tight for hand-stretching" },
    { key:"salt",      label:"Salt",       lo:2.5,  hi:3.0,  unit:"%",  note:"AVPN standard" },
    { key:"tempC",     label:"Prove temp", lo:16,   hi:24,   unit:"°C", note:"room temp or cool" },
    { key:"hours",     label:"Prove time", lo:18,   hi:48,   unit:"h",  note:"min 18 h for structure" },
    { key:"ovenC",     label:"Oven",       lo:430,  hi:500,  unit:"°C", note:"pizza oven required" },
  ],
  ny: [
    { key:"protein",   label:"Protein",    lo:12.0, hi:13.5, unit:"%",  note:"bread or high-gluten flour" },
    { key:"hydration", label:"Hydration",  lo:60,   hi:65,   unit:"%",  note:"workable, slightly tacky" },
    { key:"salt",      label:"Salt",       lo:1.8,  hi:2.5,  unit:"%",  note:"restrained — cheese is salty" },
    { key:"tempC",     label:"Prove temp", lo:2,    hi:7,    unit:"°C", note:"cold fridge proof" },
    { key:"hours",     label:"Prove time", lo:24,   hi:72,   unit:"h",  note:"longer = more flavour" },
    { key:"ovenC",     label:"Oven",       lo:260,  hi:320,  unit:"°C", note:"as hot as home oven allows" },
  ],
  detroit: [
    { key:"protein",   label:"Protein",    lo:12.0, hi:13.0, unit:"%",  note:"AP or bread flour" },
    { key:"hydration", label:"Hydration",  lo:68,   hi:78,   unit:"%",  note:"high — pan holds the dough" },
    { key:"salt",      label:"Salt",       lo:1.8,  hi:2.5,  unit:"%",  note:"standard" },
    { key:"tempC",     label:"Prove temp", lo:18,   hi:26,   unit:"°C", note:"room temp, same day" },
    { key:"hours",     label:"Prove time", lo:3,    hi:8,    unit:"h",  note:"quick same-day rise" },
    { key:"ovenC",     label:"Oven",       lo:260,  hi:295,  unit:"°C", note:"pan pizza heat" },
  ],
  roman: [
    { key:"protein",   label:"Protein",    lo:12.0, hi:13.5, unit:"%",  note:"strong flour for high hydration" },
    { key:"hydration", label:"Hydration",  lo:75,   hi:85,   unit:"%",  note:"very wet — use a tray" },
    { key:"salt",      label:"Salt",       lo:2.0,  hi:2.5,  unit:"%",  note:"standard" },
    { key:"tempC",     label:"Prove temp", lo:2,    hi:7,    unit:"°C", note:"slow cold proof" },
    { key:"hours",     label:"Prove time", lo:24,   hi:72,   unit:"h",  note:"long cold ferment" },
    { key:"ovenC",     label:"Oven",       lo:280,  hi:320,  unit:"°C", note:"deck-oven style" },
  ],
  sourdough: [
    { key:"protein",   label:"Protein",    lo:12.0, hi:13.5, unit:"%",  note:"strong flour for long ferment" },
    { key:"hydration", label:"Hydration",  lo:68,   hi:78,   unit:"%",  note:"manageable with good gluten" },
    { key:"salt",      label:"Salt",       lo:2.0,  hi:2.8,  unit:"%",  note:"acid compensates slightly" },
    { key:"tempC",     label:"Prove temp", lo:2,    hi:8,    unit:"°C", note:"fridge retard for flavour" },
    { key:"hours",     label:"Prove time", lo:18,   hi:48,   unit:"h",  note:"long cold ferment" },
    { key:"ovenC",     label:"Oven",       lo:250,  hi:320,  unit:"°C", note:"steel helps at lower temps" },
  ],
};

const TONE = { good: "#648A45", warn: "#C2641F", bad: "#C5362A" };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function tempColor(tempC) {
  const t = clamp((tempC - 2) / (35 - 2), 0, 1);
  const c1 = [61, 110, 120], c2 = [199, 125, 56];
  const ch = c1.map((a, i) => Math.round(a + (c2[i] - a) * t));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

// deterministic RNG so pictograms morph with settings, not reshuffle each render
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CRUMB_PTS = (() => {
  const rnd = mulberry32(7), cols = 22, rows = 4, pts = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      pts.push({
        x: (c + 0.5) / cols + (rnd() - 0.5) * 0.05,
        y: (r + 0.5) / rows + (rnd() - 0.5) * 0.18,
        v: rnd(),
      });
  return pts;
})();
const TOPPINGS = (() => {
  const rnd = mulberry32(19), arr = [];
  for (let i = 0; i < 9; i++) {
    const ang = rnd() * Math.PI * 2, rad = 8 + rnd() * 34;
    arr.push({ kind: i % 3 === 0 ? "basil" : "mozz", ang, rad, s: 5 + rnd() * 5 });
  }
  return arr;
})();
const LEOPARD = (() => {
  const rnd = mulberry32(23), arr = [];
  for (let i = 0; i < 18; i++) arr.push({ ang: rnd() * Math.PI * 2, w: 4 + rnd() * 5, h: 3 + rnd() * 4 });
  return arr;
})();
const CRUST_STOPS = [[0, [232, 207, 158]], [0.45, [201, 138, 60]], [0.75, [154, 90, 34]], [1, [74, 42, 18]]];
function lerpStops(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      const f = (t - p0) / (p1 - p0 || 1);
      const c = c0.map((a, k) => Math.round(a + (c1[k] - a) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const l = stops[stops.length - 1][1];
  return `rgb(${l[0]},${l[1]},${l[2]})`;
}

const SOURCES = [
  { group: "Fermentation", groupKey: "sources.group.fermentation", items: [
    { t: "Microbial leavening & time → digestibility/FODMAPs of Neapolitan pizza", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12027146/" },
    { t: "Sourdough biga → glycemic index of Pinsa Romana", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10346773/" },
    { t: "Lactobacillus groups in semolina pizza doughs", u: "https://www.mdpi.com/2311-5637/4/3/61" },
    { t: "Reducing fermentation time (rheofermentometer)", u: "https://www.researchgate.net/publication/262662318" },
    { t: "Fermentation & baking → antioxidant content", u: "https://www.eurekalert.org/news-releases/848139" },
    { t: "Thermodynamic sensors to monitor fermentation", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8914819/" },
  ] },
  { group: "Flour & gluten", groupKey: "sources.group.flourGluten", items: [
    { t: "Flour protein → dough & crust (etliekmek)", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7026350/" },
    { t: "Gluten content → water migration (LF-NMR)", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11012212/" },
    { t: "Gluten protein transformations during processing", u: "https://www.sciencedirect.com/science/article/pii/S0023643825000258" },
    { t: "Protein content in wholegrain refrigerated dough", u: "https://onlinelibrary.wiley.com/doi/full/10.1002/cche.10894" },
    { t: "Protein & baking quality across flour brands", u: "https://www.tandfonline.com/doi/full/10.1080/15428052.2023.2191874" },
    { t: "Extruded lentil flour → gluten-free pizza", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8834442/" },
  ] },
  { group: "Salt & rheology", groupKey: "sources.group.saltRheology", items: [
    { t: "Salt, water & temperature on wheat dough rheology", u: "https://www.researchgate.net/publication/230486758" },
    { t: "Low-sodium sea salt → dough rheology & bread", u: "https://www.mdpi.com/2076-3417/12/9/4344" },
  ] },
  { group: "Over-fermentation", groupKey: "sources.group.overFermentation", items: [
    { t: "CO₂-induced gluten network rupture and yeast metabolites during fermentation", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7795266/" },
    { t: "Microbial proteases in baked goods: gluten modification and immunogenicity", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5302405/" },
    { t: "Under- and over-fermented pizza dough: causes and effects (PizzaBlab)", u: "https://www.pizzablab.com/learning-and-resources/fermentation/under-and-over-fermentation/" },
    { t: "Cold vs. room-temperature fermentation: which makes the best pizza? (PizzaBlab)", u: "https://www.pizzablab.com/learning-and-resources/fermentation/pizza-dough-fermentation-methods/" },
    { t: "Cold-proofing pizza dough — technique and science (Modernist Cuisine)", u: "https://modernistcuisine.com/mp/cold-proofing-pizza-dough/" },
    { t: "Temperature control in pizza dough fermentation (PMQ Pizza)", u: "https://www.pmq.com/dont-underestimate-the-importance-of-temperature-control-in-pizza-dough-fermentation/" },
    { t: "The science behind pizza fermentation: yeast, enzymes & flavour (Dough School)", u: "https://www.dough.school/guides/fermentation-science" },
    { t: "Effects of temperature on fermentation rate of baker's yeast — Q10 study (OSU)", u: "https://undergradsciencejournals.okstate.edu/index.php/jibi/article/view/8265" },
  ] },
  { group: "Baking & storage", groupKey: "sources.group.bakingStorage", items: [
    { t: "Salts → acrylamide, HMF & flavour in crust-like dough", u: "https://www.sciencedirect.com/science/article/pii/S0308814622033209" },
    { t: "Acrylamide in bakery, snack & fried products", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9749820/" },
    { t: "Glycerol monooleate → frozen dough quality", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11765111/" },
    { t: "PizzaBlab — practitioner science (kneading, FDT, baking)", u: "https://www.pizzablab.com" },
  ] },
];

// ---- flour-strength model -------------------------------------------
function flourProfile(protein, pl) {
  const W = clamp(Math.round((protein - 6) * 40), 60, 400);
  const categoryKey =
    protein < 10.5 ? "flour.soft"
    : protein < 12 ? "flour.medium"
    : protein < 13.5 ? "flour.strong"
    : "flour.veryStrong";
  const center = 55 + (protein - 9) * 2.833 + pl * 2; // elastic flours take a touch more water
  const hydrLo = Math.round(center - 4);
  const hydrHi = Math.round(center + 4);
  const maxHours = clamp(6 * Math.pow(2, (protein - 9) / 1.5), 8, 120);
  return { W, categoryKey, hydrLo, hydrHi, maxHours };
}

function hydrationVerdict(hydration, fp) {
  if (hydration > fp.hydrHi + 2) return { tone: "bad", code: "verdict.hydration.high", params: {} };
  if (hydration > fp.hydrHi) return { tone: "warn", code: "verdict.hydration.wet", params: {} };
  if (hydration < fp.hydrLo - 2) return { tone: "warn", code: "verdict.hydration.dry", params: {} };
  return { tone: "good", code: "verdict.hydration.good", params: { lo: fp.hydrLo, hi: fp.hydrHi } };
}

function fermentVerdict(hours, fp) {
  const m = Math.round(fp.maxHours);
  if (hours > fp.maxHours * 1.25) return { tone: "bad", code: "verdict.ferment.tooLong", params: { m } };
  if (hours > fp.maxHours) return { tone: "warn", code: "verdict.ferment.limit", params: { m } };
  return { tone: "good", code: "verdict.ferment.good", params: { m } };
}

function overProofRecommendations(inp, fp) {
  const raw = inp.hours / fp.maxHours;
  if (raw < 0.8) return null;
  const severity = raw >= 1.25 ? 'bad' : raw >= 1 ? 'warn' : 'caution';
  const labelCode = `overproof.${severity}`;
  const whyCode = raw >= 1 ? 'overproof.why.over' : 'overproof.why.near';
  const whyParams = raw >= 1
    ? { tempC: inp.tempC, protein: inp.protein, maxHours: Math.round(fp.maxHours) }
    : { maxHours: Math.round(fp.maxHours), headroom: Math.round(fp.maxHours - inp.hours) };
  const levers = [];
  if (inp.protein < 13)             levers.push({ kCode: 'overproof.lever.proteinKey',     vCode: 'overproof.lever.protein',     params: { val: inp.protein } });
  if (inp.tempC > 10)               levers.push({ kCode: 'overproof.lever.temperatureKey', vCode: 'overproof.lever.temperature', params: { val: inp.tempC } });
  if (inp.salt < 2.5)               levers.push({ kCode: 'overproof.lever.saltKey',        vCode: 'overproof.lever.salt',        params: { val: inp.salt } });
  levers.push(                       { kCode: 'overproof.lever.timeKey',         vCode: 'overproof.lever.time',        params: { val: Math.max(1, Math.round(inp.hours - fp.maxHours * 0.85)) } });
  if (inp.preferment === 'straight') levers.push({ kCode: 'overproof.lever.prefermentKey', vCode: 'overproof.lever.preferment',  params: {} });
  if (inp.hydration > 68)           levers.push({ kCode: 'overproof.lever.hydrationKey',   vCode: 'overproof.lever.hydration',   params: { val: inp.hydration } });
  return { raw, severity, labelCode, whyCode, whyParams, levers };
}

// ---- bake model ------------------------------------------------------
function bakeProfile(ovenC, hydration, salt, sugarPct, oilPct, surface) {
  const k = SURF[surface].k;
  let t = 116 * Math.exp(-0.0098 * ovenC);     // minutes, inverse-exponential
  t *= 1 + (hydration - 60) * 0.004;           // wetter sets a touch slower
  t *= 1.1 - 0.18 * k;                          // a better conductor sets the base faster
  t = clamp(t, 0.4, 30);
  let top = 100 / (1 + Math.exp(-(ovenC - 290) / 48));
  top += (salt - SALT_REF) * 4 + sugarPct * 5 + oilPct * 1.5; // residual sugar + added sugar/fat brown
  top = clamp(top, 3, 100);
  const base = clamp(top * (0.4 + 0.5 * k) + k * 22, 3, 100);  // surface drives base browning
  const leopard = ovenC >= 425 && t <= 2.2;
  const acryl = top >= 86 || base >= 90;        // very dark crust -> acrylamide rises
  const styleKey =
    ovenC >= 430 ? "bakeStyle.neapolitan"
    : ovenC >= 340 ? "bakeStyle.artisan"
    : ovenC >= 280 ? "bakeStyle.ny"
    : ovenC >= 240 ? "bakeStyle.homeOven"
    : "bakeStyle.lowPan";
  return { t, colour: top, base, leopard, acryl, styleKey };
}

function digestScore(hours, tempC, leavening, preferment) {
  let d = 28 + 14 * Math.log2(Math.max(hours, 2) / 4);
  if (leavening === "sourdough") d += 22;       // LAB break down FODMAPs/fructans
  if (tempC <= 10) d += 8;                        // slow cold ferment = more breakdown
  if (preferment !== "straight") d += 8;
  return clamp(Math.round(d), 5, 99);
}
function digestVerdict(d) {
  if (d >= 68) return { tone: "good", code: "verdict.digest.easy", params: { d } };
  if (d >= 45) return { tone: "warn", code: "verdict.digest.moderate", params: { d } };
  return { tone: "warn", code: "verdict.digest.short", params: { d } };
}

function bakeVerdict(b, ovenC) {
  if (b.leopard) return { tone: "good", code: "verdict.bake.leopard", params: {} };
  if (ovenC >= 430) return { tone: "warn", code: "verdict.bake.veryHot", params: {} };
  if (ovenC >= 280) return { tone: "good", code: "verdict.bake.golden", params: {} };
  if (ovenC >= 240) return { tone: "good", code: "verdict.bake.homeOven", params: {} };
  return { tone: "warn", code: "verdict.bake.low", params: {} };
}

function fmtBake(t) {
  if (t < 2) return `~${Math.round(t * 60)} s`;
  if (t < 6) return `~${t.toFixed(1)} min`;
  return `~${Math.round(t)} min`;
}
function crustLabelKey(c) {
  return c < 30 ? "crust.pale" : c < 55 ? "crust.golden" : c < 78 ? "crust.deepGolden" : "crust.charred";
}

function compute({ tempC, hours, yeastType, doughWeight, hydration, salt, oilPct, sugarPct, leavening, preferment, starterStr }) {
  const rateFactor = Math.pow(Q10, (tempC - REF.tempC) / 10);
  const saltRate = Math.exp(-0.12 * (salt - SALT_REF)); // more salt -> slower yeast
  const flour = doughWeight / (1 + hydration / 100 + salt / 100 + oilPct / 100 + sugarPct / 100);
  const waterG = flour * (hydration / 100);
  const saltGrams = flour * (salt / 100);
  const oilGrams = flour * (oilPct / 100);
  const sugarGrams = flour * (sugarPct / 100);
  const pfYeast = preferment !== "straight" ? 0.85 : 1; // preferment carries some leavening
  let idyPct = 0, pct = 0, grams = 0, tsp = null, levainPct = 0, levainGrams = 0;
  if (leavening === "sourdough") {
    // anchored on ~15% levain → roughly 8 h at 24 °C; a vigorous starter needs less
    const strength = 0.7 + (starterStr / 100) * 0.6; // 0.7 sluggish .. 1.3 vigorous
    levainPct = clamp(150 / (hours * rateFactor * saltRate * strength), 3, 40);
    levainGrams = flour * (levainPct / 100);
  } else {
    idyPct = K / (hours * rateFactor * saltRate);
    pct = idyPct * TYPE[yeastType].mult * pfYeast;
    grams = flour * (pct / 100);
    const gPerTsp = TYPE[yeastType].gPerTsp;
    tsp = gPerTsp ? grams / gPerTsp : null;
  }
  return { rateFactor, saltRate, idyPct, pct, flour, grams, saltGrams, oilGrams, sugarGrams, tsp, waterG, levainPct, levainGrams };
}

// pure rise model — Gompertz values only, no pixels
function riseModel(tempC, hours, protein) {
  const lagFrac = clamp(0.12 + (25 - tempC) * 0.006, 0.08, 0.45);
  const lambda = hours * lagFrac;
  const span = Math.max(hours - lambda, 0.5);
  const Arise = 90 + (protein - 8) * 8;
  const mu = (Arise * 3.97) / (Math.E * span);
  const maxHours = clamp(6 * Math.pow(2, (protein - 9) / 1.5), 8, 120);
  const kd = clamp(2.0 / maxHours, 0.01, 0.2);
  const tMax = hours * 1.4;
  const riseAt = (t) => Arise * Math.exp(-Math.exp((mu * Math.E) / Arise * (lambda - t) + 1));
  const vAt = (t) => { let r = riseAt(t); if (t > maxHours) r *= Math.exp(-kd * (t - maxHours)); return 100 + r; };
  return { lambda, mu, Arise, maxHours, kd, tMax, collapses: maxHours < tMax, hours, vAt };
}
function proofQualityFn(hours, maxHours) {
  const over = clamp((hours - maxHours) / maxHours, 0, 1.5);
  return clamp(1 - over * 0.6, 0.25, 1);
}
function waterTempFn(ddt, roomTemp, mixMethod, preferment) {
  const friction = FRICTION[mixMethod].f;
  const nFactor = preferment !== "straight" ? 4 : 3; // preferment held at room temp -> 4-factor
  return { temp: clamp(Math.round(nFactor * ddt - (nFactor - 1) * roomTemp - friction), 0, 48), friction, nFactor };
}
function batchFn(doughWeight, ballCount) {
  const balls = ballCount ? Math.max(1, Math.round(ballCount)) : Math.max(1, Math.round(doughWeight / 250));
  return { balls, ballW: Math.round(doughWeight / balls) };
}
function geometryFn(hydration, protein, ovenC, proof, pl) {
  const openness = clamp((hydration - 50) / 25, 0, 1);
  const strength = clamp((protein - 8) / 7, 0, 1);
  const springFrac = clamp((ovenC - 230) / 240, 0, 1);
  const rimIndex = (20 + springFrac * 80 + strength * 24) * proof * (1 + pl * 0.12);
  return { openness, strength, springFrac, rimIndex };
}

// single pure entry point: inputs -> every derived value
function computeAll(inp) {
  const pl = (inp.plVal - 50) / 50;
  const r = compute(inp);
  const fp = flourProfile(inp.protein, pl);
  const rise = riseModel(inp.tempC, inp.hours, inp.protein);
  const proof = proofQualityFn(inp.hours, fp.maxHours);
  const bake = bakeProfile(inp.ovenC, inp.hydration, inp.salt, inp.sugarPct, inp.oilPct, inp.surface);
  const digest = digestScore(inp.hours, inp.tempC, inp.leavening, inp.preferment);
  const water = waterTempFn(inp.ddt, inp.roomTemp, inp.mixMethod, inp.preferment);
  const batch = batchFn(inp.doughWeight, inp.ballCount);
  const geometry = geometryFn(inp.hydration, inp.protein, inp.ovenC, proof, pl);
  const verdicts = {
    hydration: hydrationVerdict(inp.hydration, fp),
    ferment: fermentVerdict(inp.hours, fp),
    digestion: digestVerdict(digest),
    bake: bakeVerdict(bake, inp.ovenC),
  };
  return { r, fp, rise, proof, bake, digest, water, batch, geometry, verdicts, pl, overProof: overProofRecommendations(inp, fp) };
}

// view-only: turn a rise model into SVG path strings
function buildRisePaths(m, w, h, pad, vAxis) {
  const x = (t) => pad.l + (t / m.tMax) * (w - pad.l - pad.r);
  const y = (v) => h - pad.b - ((v - 100) / (vAxis - 100)) * (h - pad.t - pad.b);
  let line = "";
  for (let i = 0; i <= 120; i++) { const t = (i / 120) * m.tMax; line += (i ? "L" : "M") + x(t).toFixed(1) + " " + y(m.vAt(t)).toFixed(1) + " "; }
  const baselineY = h - pad.b;
  const area = line + `L${x(m.tMax).toFixed(1)} ${baselineY.toFixed(1)} L${pad.l.toFixed(1)} ${baselineY.toFixed(1)} Z`;
  return { line, area, target: { x: x(m.hours), y: y(m.vAt(m.hours)) }, lagX: x(m.lambda), baselineY };
}

// ---- dual export: CommonJS for tests, global for the browser -----------
const __ENGINE__ = {
  clamp,
  tempColor,
  mulberry32,
  lerpStops,
  flourProfile,
  hydrationVerdict,
  fermentVerdict,
  overProofRecommendations,
  bakeProfile,
  digestScore,
  digestVerdict,
  bakeVerdict,
  fmtBake,
  crustLabelKey,
  compute,
  riseModel,
  proofQualityFn,
  waterTempFn,
  batchFn,
  geometryFn,
  computeAll,
  buildRisePaths,
  REF,
  K,
  Q10,
  SALT_REF,
  TYPE,
  SURF,
  FRICTION,
  V_AXIS,
  EMBER,
  CONF,
  GRAPH,
  DG,
  PIZZA_PRESETS,
  OVEN_PRESETS,
  FLOUR_PRESETS,
  FLOUR_REGIONS,
  DOUGH_RANGES,
  DOUGH_ENUMS,
  DOUGH_PARAMS,
  sanitizeInputs,
  STYLE_GUIDELINES,
  TONE,
  CRUMB_PTS,
  TOPPINGS,
  LEOPARD,
  CRUST_STOPS,
  SOURCES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __ENGINE__;
if (typeof window !== 'undefined') window.DoughEngine = __ENGINE__;

})();
