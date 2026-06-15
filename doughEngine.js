// Pure computation engine — no DOM, no React, no JSX.
// All functions are deterministic: same inputs → same outputs.
// Exported for testing; also inlined into index.html.

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
  { group: "Fermentation", items: [
    { t: "Microbial leavening & time → digestibility/FODMAPs of Neapolitan pizza", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12027146/" },
    { t: "Sourdough biga → glycemic index of Pinsa Romana", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10346773/" },
    { t: "Lactobacillus groups in semolina pizza doughs", u: "https://www.mdpi.com/2311-5637/4/3/61" },
    { t: "Reducing fermentation time (rheofermentometer)", u: "https://www.researchgate.net/publication/262662318" },
    { t: "Fermentation & baking → antioxidant content", u: "https://www.eurekalert.org/news-releases/848139" },
    { t: "Thermodynamic sensors to monitor fermentation", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8914819/" },
  ] },
  { group: "Flour & gluten", items: [
    { t: "Flour protein → dough & crust (etliekmek)", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7026350/" },
    { t: "Gluten content → water migration (LF-NMR)", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11012212/" },
    { t: "Gluten protein transformations during processing", u: "https://www.sciencedirect.com/science/article/pii/S0023643825000258" },
    { t: "Protein content in wholegrain refrigerated dough", u: "https://onlinelibrary.wiley.com/doi/full/10.1002/cche.10894" },
    { t: "Protein & baking quality across flour brands", u: "https://www.tandfonline.com/doi/full/10.1080/15428052.2023.2191874" },
    { t: "Extruded lentil flour → gluten-free pizza", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8834442/" },
  ] },
  { group: "Salt & rheology", items: [
    { t: "Salt, water & temperature on wheat dough rheology", u: "https://www.researchgate.net/publication/230486758" },
    { t: "Low-sodium sea salt → dough rheology & bread", u: "https://www.mdpi.com/2076-3417/12/9/4344" },
  ] },
  { group: "Over-fermentation", items: [
    { t: "CO₂-induced gluten network rupture and yeast metabolites during fermentation", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7795266/" },
    { t: "Microbial proteases in baked goods: gluten modification and immunogenicity", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5302405/" },
    { t: "Under- and over-fermented pizza dough: causes and effects (PizzaBlab)", u: "https://www.pizzablab.com/learning-and-resources/fermentation/under-and-over-fermentation/" },
    { t: "Cold vs. room-temperature fermentation: which makes the best pizza? (PizzaBlab)", u: "https://www.pizzablab.com/learning-and-resources/fermentation/pizza-dough-fermentation-methods/" },
    { t: "Cold-proofing pizza dough — technique and science (Modernist Cuisine)", u: "https://modernistcuisine.com/mp/cold-proofing-pizza-dough/" },
    { t: "Temperature control in pizza dough fermentation (PMQ Pizza)", u: "https://www.pmq.com/dont-underestimate-the-importance-of-temperature-control-in-pizza-dough-fermentation/" },
    { t: "The science behind pizza fermentation: yeast, enzymes & flavour (Dough School)", u: "https://www.dough.school/guides/fermentation-science" },
    { t: "Effects of temperature on fermentation rate of baker's yeast — Q10 study (OSU)", u: "https://undergradsciencejournals.okstate.edu/index.php/jibi/article/view/8265" },
  ] },
  { group: "Baking & storage", items: [
    { t: "Salts → acrylamide, HMF & flavour in crust-like dough", u: "https://www.sciencedirect.com/science/article/pii/S0308814622033209" },
    { t: "Acrylamide in bakery, snack & fried products", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9749820/" },
    { t: "Glycerol monooleate → frozen dough quality", u: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11765111/" },
    { t: "PizzaBlab — practitioner science (kneading, FDT, baking)", u: "https://www.pizzablab.com" },
  ] },
];

// ---- flour-strength model -------------------------------------------
function flourProfile(protein, pl) {
  const W = clamp(Math.round((protein - 6) * 40), 60, 400);
  const category =
    protein < 10.5 ? "Soft / weak"
    : protein < 12 ? "Medium"
    : protein < 13.5 ? "Strong (pizza)"
    : "Very strong";
  const center = 55 + (protein - 9) * 2.833 + pl * 2; // elastic flours take a touch more water
  const hydrLo = Math.round(center - 4);
  const hydrHi = Math.round(center + 4);
  const maxHours = clamp(6 * Math.pow(2, (protein - 9) / 1.5), 8, 120);
  return { W, category, hydrLo, hydrHi, maxHours };
}

function hydrationVerdict(hydration, fp) {
  if (hydration > fp.hydrHi + 2)
    return { tone: "bad", text: `High for this flour — expect a slack, sticky dough that's hard to shape.` };
  if (hydration > fp.hydrHi)
    return { tone: "warn", text: `A touch wet; workable with confident handling.` };
  if (hydration < fp.hydrLo - 2)
    return { tone: "warn", text: `Drier than this flour can take — room for a more open crumb.` };
  return { tone: "good", text: `Well matched to a ${fp.hydrLo}–${fp.hydrHi}% range.` };
}

function fermentVerdict(hours, fp) {
  const m = Math.round(fp.maxHours);
  if (hours > fp.maxHours * 1.25)
    return { tone: "bad", text: `Too long (~${m} h max). Gluten breaks down — the dough slackens and over-proofs.` };
  if (hours > fp.maxHours)
    return { tone: "warn", text: `Near this flour's limit (~${m} h). Watch for over-proofing.` };
  return { tone: "good", text: `Comfortable — this flour holds up to ~${m} h here.` };
}

function overProofRecommendations(inp, fp) {
  const raw = inp.hours / fp.maxHours;
  if (raw < 0.8) return null;
  const severity = raw >= 1.25 ? 'bad' : raw >= 1 ? 'warn' : 'caution';
  const label = severity === 'bad' ? 'Over-proved' : severity === 'warn' ? 'Exceeds capacity' : 'Approaching limit';
  const why = raw >= 1
    ? `At ${inp.tempC} °C with ${inp.protein}% protein flour, protease enzymes and CO₂ pressure begin to irreversibly rupture the gluten network after ~${Math.round(fp.maxHours)} h. The dough loses gas-holding capacity and collapses into a slack, dense mass.`
    : `Beyond ${Math.round(fp.maxHours)} h this flour's gluten becomes vulnerable — protease enzymes attack the protein bonds and CO₂ pressure physically tears the network. You have ~${Math.round(fp.maxHours - inp.hours)} h of headroom.`;
  const levers = [];
  if (inp.protein < 13)             levers.push({ k: 'Flour protein', v: `raise to 13%+ — fermentation capacity roughly doubles per +1.5% protein (now ${inp.protein}%)` });
  if (inp.tempC > 10)               levers.push({ k: 'Temperature',   v: `drop below 10 °C — cold slows yeast ~90% while enzymes only slow ~55%, dramatically extending the safe window (now ${inp.tempC} °C)` });
  if (inp.salt < 2.5)               levers.push({ k: 'Salt',          v: `raise to 2.5–3% — tightens the gluten network and slows yeast exponentially via osmotic stress (now ${inp.salt}%)` });
  levers.push(                       { k: 'Time',         v: `reduce by ${Math.max(1, Math.round(inp.hours - fp.maxHours * 0.85))} h to return inside the safe window` });
  if (inp.preferment === 'straight') levers.push({ k: 'Preferment',   v: 'switch to biga or poolish — pre-fermented acidity buffers further yeast activity and reduces the fresh yeast load' });
  if (inp.hydration > 68)           levers.push({ k: 'Hydration',     v: `reduce to ≤68% — more water creates a more mobile environment that accelerates enzyme activity (now ${inp.hydration}%)` });
  return { raw, severity, label, why, levers };
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
  const style =
    ovenC >= 430 ? "Neapolitan"
    : ovenC >= 340 ? "Artisan / high-heat"
    : ovenC >= 280 ? "New York"
    : ovenC >= 240 ? "Home oven"
    : "Low / pan";
  return { t, colour: top, base, leopard, acryl, style };
}

function digestScore(hours, tempC, leavening, preferment) {
  let d = 28 + 14 * Math.log2(Math.max(hours, 2) / 4);
  if (leavening === "sourdough") d += 22;       // LAB break down FODMAPs/fructans
  if (tempC <= 10) d += 8;                        // slow cold ferment = more breakdown
  if (preferment !== "straight") d += 8;
  return clamp(Math.round(d), 5, 99);
}
function digestVerdict(d) {
  if (d >= 68) return { tone: "good", text: `Easy on the gut (${d}/100) — long, slow fermentation breaks down more fructans.` };
  if (d >= 45) return { tone: "warn", text: `Moderate (${d}/100) — a longer or sourdough prove breaks down more.` };
  return { tone: "warn", text: `Short prove (${d}/100) — less FODMAP breakdown; extend the time for easier digestion.` };
}

function bakeVerdict(b, ovenC) {
  if (b.leopard)
    return { tone: "good", text: `Leoparding likely — fast bake, soft interior, charred spots. Needs a pizza or wood oven.` };
  if (ovenC >= 430)
    return { tone: "warn", text: `Very hot and quick, but only a dedicated pizza oven reaches this.` };
  if (ovenC >= 280)
    return { tone: "good", text: `Even golden crust with a crisp base — the classic range.` };
  if (ovenC >= 240)
    return { tone: "good", text: `Home-oven territory — golden and even; bake on a preheated steel or stone.` };
  return { tone: "warn", text: `Low — the crust can dry and stay pale before it browns. Preheat a steel hard.` };
}

function fmtBake(t) {
  if (t < 2) return `~${Math.round(t * 60)} s`;
  if (t < 6) return `~${t.toFixed(1)} min`;
  return `~${Math.round(t)} min`;
}
function crustLabel(c) {
  return c < 30 ? "Pale · light gold" : c < 55 ? "Golden" : c < 78 ? "Deep golden" : "Charred · leopard";
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
function batchFn(doughWeight) {
  const balls = Math.max(1, Math.round(doughWeight / 250));
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
  const batch = batchFn(inp.doughWeight);
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



module.exports = {
  clamp,
  flourProfile,
  hydrationVerdict,
  fermentVerdict,
  overProofRecommendations,
  bakeProfile,
  digestScore,
  digestVerdict,
  bakeVerdict,
  fmtBake,
  crustLabel,
  compute,
  riseModel,
  proofQualityFn,
  waterTempFn,
  batchFn,
  geometryFn,
  computeAll,
  buildRisePaths,
  REF, K, Q10, SALT_REF, TYPE, SURF, FRICTION,
};
