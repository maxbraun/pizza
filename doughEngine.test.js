// Unit tests for the pizza dough calculation engine.
// Run: node --test doughEngine.test.js
// No build step, no npm — uses Node 18+ built-in test runner.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  clamp,
  flourProfile,
  analyseFlour,
  wFromProtein,
  plToSlider,
  absorptionFromFlour,
  bandScore,
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
  REF, K, Q10, SALT_REF, TYPE, SURF, FRICTION, FLOUR_FIELDS, STYLE_PL_RANGE, STYLE_GUIDELINES,
} = require('./doughEngine.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Assert a number is within ±delta of expected
function near(actual, expected, delta = 0.01, msg) {
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= delta, `${msg ?? ''} expected ${actual} ≈ ${expected} (±${delta}), diff=${diff.toFixed(4)}`);
}

// Default inputs that match the Q10 anchor (21 °C, 8 h, IDY, 2.5% salt)
const BASE = {
  tempC: 21, hours: 8, protein: 12, plVal: 50,
  hydration: 60, salt: 2.5, oilPct: 0, sugarPct: 0,
  leavening: 'commercial', yeastType: 'idy', starterStr: 50,
  preferment: 'straight', roomTemp: 20, ddt: 24,
  mixMethod: 'hand', doughWeight: 1000,
  ovenC: 250, surface: 'steel',
};

// ─────────────────────────────────────────────────────────────────────────────
// clamp
// ─────────────────────────────────────────────────────────────────────────────

describe('clamp', () => {
  test('returns value when within range', () => assert.equal(clamp(5, 0, 10), 5));
  test('clamps to lower bound', () => assert.equal(clamp(-3, 0, 10), 0));
  test('clamps to upper bound', () => assert.equal(clamp(15, 0, 10), 10));
  test('exact lower bound passes through', () => assert.equal(clamp(0, 0, 10), 0));
  test('exact upper bound passes through', () => assert.equal(clamp(10, 0, 10), 10));
});

// ─────────────────────────────────────────────────────────────────────────────
// flourProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('flourProfile', () => {
  test('W value is (protein−6)×40', () => {
    assert.equal(flourProfile(12, 0).W, (12 - 6) * 40); // 240
    assert.equal(flourProfile(13, 0).W, (13 - 6) * 40); // 280
  });

  test('W is clamped to [60, 400]', () => {
    assert.equal(flourProfile(7.5, 0).W, 60);  // (7.5-6)*40=60, at boundary
    assert.equal(flourProfile(16, 0).W, 400);  // would be 400, capped
  });

  test('protein categories', () => {
    assert.equal(flourProfile(9.5, 0).categoryKey, 'flour.soft');
    assert.equal(flourProfile(11, 0).categoryKey, 'flour.medium');
    assert.equal(flourProfile(12.5, 0).categoryKey, 'flour.strong');
    assert.equal(flourProfile(14, 0).categoryKey, 'flour.veryStrong');
  });

  test('maxHours doubles roughly per +1.5% protein', () => {
    const h9  = flourProfile(9,  0).maxHours;  // 6 × 2^0 = 6 → clamped to 8
    const h105 = flourProfile(10.5, 0).maxHours; // 6 × 2^1 = 12
    const h12 = flourProfile(12, 0).maxHours;  // 6 × 2^2 = 24
    const h135 = flourProfile(13.5, 0).maxHours; // 6 × 2^3 = 48
    assert.equal(h9,   8);   // clamped minimum
    assert.equal(h105, 12);
    assert.equal(h12,  24);
    assert.equal(h135, 48);
  });

  test('maxHours clamped to [8, 120]', () => {
    assert.equal(flourProfile(8,  0).maxHours, 8);   // lower clamp
    assert.equal(flourProfile(16, 0).maxHours, 120); // upper clamp
  });

  test('hydration window shifts with P/L (elastic flour takes more water)', () => {
    const balanced  = flourProfile(12, 0);    // plVal=50 → pl=0
    const elastic   = flourProfile(12, 0.5);  // higher pl
    assert.ok(elastic.hydrLo > balanced.hydrLo);
    assert.ok(elastic.hydrHi > balanced.hydrHi);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hydrationVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe('hydrationVerdict', () => {
  // protein=12, pl=0 → hydrLo≈59, hydrHi≈67
  const fp = flourProfile(12, 0);

  test('within range → good', () => {
    assert.equal(hydrationVerdict(63, fp).tone, 'good');
  });

  test('just above upper limit → warn', () => {
    assert.equal(hydrationVerdict(fp.hydrHi + 1, fp).tone, 'warn');
  });

  test('well above upper limit → bad', () => {
    assert.equal(hydrationVerdict(fp.hydrHi + 3, fp).tone, 'bad');
  });

  test('below lower limit → warn', () => {
    assert.equal(hydrationVerdict(fp.hydrLo - 3, fp).tone, 'warn');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fermentVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe('fermentVerdict', () => {
  const fp = flourProfile(12, 0); // maxHours = 24

  test('well inside capacity → good', () => {
    assert.equal(fermentVerdict(12, fp).tone, 'good');
  });

  test('slightly over → warn', () => {
    assert.equal(fermentVerdict(fp.maxHours + 1, fp).tone, 'warn');
  });

  test('more than 25% over → bad', () => {
    assert.equal(fermentVerdict(Math.ceil(fp.maxHours * 1.26), fp).tone, 'bad');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q10 yeast model (via compute)
// ─────────────────────────────────────────────────────────────────────────────

describe('Q10 yeast model', () => {
  test('at reference conditions: IDY% ≈ 0.3%', () => {
    const r = compute({ ...BASE, tempC: REF.tempC, hours: REF.hours, salt: SALT_REF });
    near(r.idyPct, REF.yeastPct, 0.001, 'IDY%');
  });

  test('K constant is 2.4 (%·h)', () => {
    near(K, 2.4, 0.001);
  });

  test('doubling time halves yeast requirement', () => {
    const r8  = compute({ ...BASE, hours: 8  });
    const r16 = compute({ ...BASE, hours: 16 });
    near(r16.idyPct, r8.idyPct / 2, 0.001, '2× time = ½ yeast');
  });

  test('warmer temperature reduces yeast needed (Q10 > 1)', () => {
    // Use exactly 10°C apart so the ratio = Q10^1
    const cold = compute({ ...BASE, tempC: 16 });
    const warm = compute({ ...BASE, tempC: 26 });
    assert.ok(warm.idyPct < cold.idyPct, 'warmer needs less yeast');
    // Q10=2.5 means +10°C → 2.5× faster yeast → 1/2.5 as much yeast
    near(warm.idyPct, cold.idyPct / Q10, 0.001, 'exact Q10 ratio');
  });

  test('more salt slows yeast (exponential suppression)', () => {
    const low  = compute({ ...BASE, salt: 1.5 });
    const high = compute({ ...BASE, salt: 3.5 });
    assert.ok(low.idyPct < high.idyPct, 'more salt → needs more yeast to compensate');
  });

  test('ADY requires 1.33× more than IDY', () => {
    const idy = compute({ ...BASE, yeastType: 'idy' });
    const ady = compute({ ...BASE, yeastType: 'ady' });
    near(ady.pct / idy.pct, TYPE.ady.mult, 0.001, 'ADY mult');
  });

  test('fresh yeast requires 3× more than IDY', () => {
    const idy   = compute({ ...BASE, yeastType: 'idy' });
    const fresh = compute({ ...BASE, yeastType: 'fresh' });
    near(fresh.pct / idy.pct, TYPE.fresh.mult, 0.001, 'fresh mult');
  });

  test('baker\'s % weights sum to dough weight', () => {
    const r = compute(BASE);
    const total = r.flour + r.waterG + r.saltGrams + r.oilGrams + r.sugarGrams;
    near(total, BASE.doughWeight, 1, 'ingredient total');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sourdough levain
// ─────────────────────────────────────────────────────────────────────────────

describe('sourdough levain', () => {
  const SD = { ...BASE, leavening: 'sourdough' };

  test('levainPct is in [3, 40]', () => {
    const r = compute(SD);
    assert.ok(r.levainPct >= 3 && r.levainPct <= 40, `levainPct=${r.levainPct}`);
  });

  test('stronger starter needs less levain', () => {
    const weak   = compute({ ...SD, starterStr: 10 });
    const strong = compute({ ...SD, starterStr: 90 });
    assert.ok(strong.levainPct < weak.levainPct, 'vigorous starter → less levain');
  });

  test('levain grams = levainPct% of flour', () => {
    const r = compute(SD);
    near(r.levainGrams, r.flour * (r.levainPct / 100), 0.01);
  });

  test('commercial: grams > 0; sourdough: grams = 0', () => {
    const com = compute(BASE);
    const sd  = compute(SD);
    assert.ok(com.grams > 0);
    assert.equal(sd.grams, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Water temp (FDT formula)
// ─────────────────────────────────────────────────────────────────────────────

describe('waterTempFn', () => {
  test('straight dough uses N=3 factor', () => {
    // water = 3*FDT - 2*room - friction
    const { temp, nFactor } = waterTempFn(24, 20, 'hand', 'straight');
    assert.equal(nFactor, 3);
    assert.equal(temp, 3 * 24 - 2 * 20 - FRICTION.hand.f); // 72-40-2 = 30
  });

  test('preferment uses N=4 factor', () => {
    const { temp, nFactor } = waterTempFn(24, 20, 'hand', 'poolish');
    assert.equal(nFactor, 4);
    assert.equal(temp, 4 * 24 - 3 * 20 - FRICTION.hand.f); // 96-60-2 = 34
  });

  test('stand mixer adds more friction → cooler water needed', () => {
    const hand  = waterTempFn(24, 20, 'hand',  'straight');
    const mixer = waterTempFn(24, 20, 'mixer', 'straight');
    assert.ok(mixer.temp < hand.temp, 'mixer needs cooler water');
    assert.equal(hand.temp - mixer.temp, FRICTION.mixer.f - FRICTION.hand.f); // 8-2=6
  });

  test('water temp clamped to [0, 48]', () => {
    const { temp: hot } = waterTempFn(28, 28, 'processor', 'straight');
    assert.ok(hot >= 0 && hot <= 48);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch sizing
// ─────────────────────────────────────────────────────────────────────────────

describe('batchFn', () => {
  test('1000g → 4 balls of 250g', () => {
    const b = batchFn(1000);
    assert.equal(b.balls, 4);
    assert.equal(b.ballW, 250);
  });

  test('750g → 3 balls', () => {
    assert.equal(batchFn(750).balls, 3);
  });

  test('minimum 1 ball even for small weight', () => {
    assert.equal(batchFn(100).balls, 1);
    assert.equal(batchFn(100).ballW, 100);
  });

  test('ball weight × balls ≈ dough weight', () => {
    for (const w of [250, 500, 750, 1000, 1500, 2000]) {
      const { balls, ballW } = batchFn(w);
      near(balls * ballW, w, balls, `${w}g`);
    }
  });

  test('explicit ballCount overrides the ~250g auto split', () => {
    const b = batchFn(1000, 6);
    assert.equal(b.balls, 6);
    assert.equal(b.ballW, Math.round(1000 / 6));
  });

  test('ballCount is rounded and floored at 1', () => {
    assert.equal(batchFn(1000, 2.6).balls, 3);
    assert.equal(batchFn(1000, 0).balls, 4); // falsy → falls back to auto split
    assert.equal(batchFn(1000, -2).balls, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gompertz rise model
// ─────────────────────────────────────────────────────────────────────────────

describe('riseModel', () => {
  test('rise at t=0 is close to 100% (not yet started)', () => {
    const m = riseModel(21, 8, 12);
    near(m.vAt(0), 100, 2, 'rise at t=0');
  });

  test('rise at target hours > 100%', () => {
    const m = riseModel(21, 8, 12);
    assert.ok(m.vAt(8) > 100, `rise at 8h = ${m.vAt(8).toFixed(1)}%`);
  });

  test('peak rise Arise scales with protein', () => {
    const low  = riseModel(21, 8, 10);
    const high = riseModel(21, 8, 14);
    assert.ok(high.Arise > low.Arise, 'stronger flour → higher peak rise');
  });

  test('warmer temperature shortens lag (lagFrac decreases)', () => {
    const cold = riseModel(4,  24, 12);
    const warm = riseModel(24, 24, 12);
    assert.ok(warm.lambda < cold.lambda, 'warm → shorter lag');
  });

  test('dough collapses after maxHours at t > maxHours', () => {
    const m = riseModel(21, 8, 9); // protein=9, maxHours≈8 (clamped)
    // At well past maxHours, dough should have decayed
    const atMax  = m.vAt(m.maxHours);
    const atOver = m.vAt(m.maxHours * 2);
    assert.ok(atOver < atMax, 'dough decays after maxHours');
  });

  test('collapses flag set when target hours > maxHours', () => {
    const fp = flourProfile(9, 0); // maxHours=8
    const m  = riseModel(21, 20, 9); // hours=20 >> maxHours=8
    assert.ok(m.collapses, 'should flag collapse');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// proofQualityFn
// ─────────────────────────────────────────────────────────────────────────────

describe('proofQualityFn', () => {
  test('within capacity → quality = 1', () => {
    assert.equal(proofQualityFn(12, 24), 1);
  });

  test('at exact capacity → quality = 1', () => {
    assert.equal(proofQualityFn(24, 24), 1);
  });

  test('25% over → quality reduced', () => {
    // over = (30-24)/24 = 0.25, quality = 1 - 0.25*0.6 = 0.85
    near(proofQualityFn(30, 24), 0.85, 0.001);
  });

  test('100% over → quality = 0.4', () => {
    // over = 1, quality = 1 - 1*0.6 = 0.4
    near(proofQualityFn(48, 24), 0.4, 0.001);
  });

  test('quality clamped to minimum 0.25', () => {
    assert.equal(proofQualityFn(200, 24), 0.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bake model
// ─────────────────────────────────────────────────────────────────────────────

describe('bakeProfile', () => {
  test('hotter oven = shorter bake time', () => {
    const home = bakeProfile(250, 60, 2.5, 0, 0, 'steel');
    const neo  = bakeProfile(460, 60, 2.5, 0, 0, 'stone');
    assert.ok(neo.t < home.t, `460°C=${neo.t.toFixed(2)} min should be < 250°C=${home.t.toFixed(2)} min`);
  });

  test('bake time is clamped to [0.4, 30] minutes', () => {
    const extreme_hot  = bakeProfile(500, 60, 2.5, 0, 0, 'steel');
    const extreme_cold = bakeProfile(100, 60, 2.5, 0, 0, 'rack');
    assert.ok(extreme_hot.t  >= 0.4, 'min clamp');
    assert.ok(extreme_cold.t <= 30,  'max clamp');
  });

  test('leoparding at very high temp + short bake', () => {
    const neo = bakeProfile(460, 60, 2.5, 0, 0, 'stone');
    assert.ok(neo.leopard, 'Neapolitan should leopard');
  });

  test('no leoparding at moderate home oven temp', () => {
    const home = bakeProfile(250, 60, 2.5, 0, 0, 'steel');
    assert.ok(!home.leopard, 'home oven should not leopard');
  });

  test('steel conducts better than rack → faster base browning', () => {
    const steel = bakeProfile(300, 60, 2.5, 0, 0, 'steel');
    const rack  = bakeProfile(300, 60, 2.5, 0, 0, 'rack');
    assert.ok(steel.base > rack.base, 'steel browns base more than rack');
  });

  test('sugar increases top browning', () => {
    const plain  = bakeProfile(280, 60, 2.5, 0,   0, 'steel');
    const sugary = bakeProfile(280, 60, 2.5, 2.0, 0, 'steel');
    assert.ok(sugary.colour > plain.colour, 'sugar boosts browning');
  });

  test('acrylamide flag triggers at very dark crust', () => {
    const charred = bakeProfile(480, 60, 2.5, 2, 0, 'steel');
    assert.ok(charred.acryl, 'very dark crust → acrylamide flag');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Digestibility score
// ─────────────────────────────────────────────────────────────────────────────

describe('digestScore', () => {
  test('output is in [5, 99]', () => {
    for (const [h, t, l, p] of [
      [2, 25, 'commercial', 'straight'],
      [72, 4, 'sourdough', 'poolish'],
      [8, 21, 'commercial', 'biga'],
    ]) {
      const d = digestScore(h, t, l, p);
      assert.ok(d >= 5 && d <= 99, `digestScore(${h},${t},${l},${p})=${d}`);
    }
  });

  test('sourdough boosts score by 22', () => {
    const com = digestScore(8, 21, 'commercial', 'straight');
    const sd  = digestScore(8, 21, 'sourdough',  'straight');
    assert.equal(sd - com, 22);
  });

  test('cold ferment boosts score by 8', () => {
    const warm = digestScore(8, 21, 'commercial', 'straight');
    const cold = digestScore(8, 5,  'commercial', 'straight');
    assert.equal(cold - warm, 8);
  });

  test('preferment boosts score by 8', () => {
    const straight = digestScore(8, 21, 'commercial', 'straight');
    const poolish  = digestScore(8, 21, 'commercial', 'poolish');
    assert.equal(poolish - straight, 8);
  });

  test('longer fermentation increases score', () => {
    const short = digestScore(4, 21,  'commercial', 'straight');
    const long  = digestScore(48, 21, 'commercial', 'straight');
    assert.ok(long > short, 'longer prove → higher digestibility');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fmtBake / crustLabelKey helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtBake', () => {
  test('< 2 min → seconds format', () => {
    assert.ok(fmtBake(1).includes('s'), fmtBake(1));
  });
  test('2-6 min → decimal minutes', () => {
    assert.ok(fmtBake(3.5).includes('min'), fmtBake(3.5));
    assert.ok(fmtBake(3.5).includes('.'),   fmtBake(3.5));
  });
  test('> 6 min → whole minutes', () => {
    assert.ok(fmtBake(10).includes('min'), fmtBake(10));
    assert.ok(!fmtBake(10).includes('.'),  fmtBake(10));
  });
});

describe('crustLabelKey', () => {
  test('< 30 → pale', () => assert.equal(crustLabelKey(20), 'crust.pale'));
  test('30-55 → golden', () => assert.equal(crustLabelKey(40), 'crust.golden'));
  test('55-78 → deep golden', () => assert.equal(crustLabelKey(70), 'crust.deepGolden'));
  test('≥ 78 → charred', () => assert.equal(crustLabelKey(90), 'crust.charred'));
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAll — integration tests for pizza presets
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAll — Neapolitan preset', () => {
  const inp = {
    tempC: 18, hours: 24, protein: 13, plVal: 55,
    hydration: 60, salt: 2.8, oilPct: 0, sugarPct: 0,
    leavening: 'commercial', yeastType: 'idy', preferment: 'biga',
    ovenC: 460, surface: 'stone', ddt: 23,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  };
  const M = computeAll(inp);

  test('flour + water + salt = dough weight', () => {
    near(M.r.flour + M.r.waterG + M.r.saltGrams, inp.doughWeight, 1);
  });
  test('leopard spots at 460 °C', () => assert.ok(M.bake.leopard));
  test('hydration verdict is not bad (60% is dry but valid Neapolitan)', () => {
    // At 13% protein the model's window sits at ~63–71%; 60% reads as 'warn'
    // (slightly under the recommended range), not 'bad'
    assert.notEqual(M.verdicts.hydration.tone, 'bad');
  });
  test('ferment verdict within capacity → good', () => {
    assert.equal(M.verdicts.ferment.tone, 'good');
  });
  test('proof quality = 1 (not over-proved)', () => {
    assert.equal(M.proof, 1);
  });
  test('batch = 4 balls at 250g each', () => {
    assert.equal(M.batch.balls, 4);
  });
});

describe('computeAll — long cold NY slice', () => {
  const inp = {
    tempC: 4, hours: 48, protein: 13, plVal: 50,
    hydration: 63, salt: 2, oilPct: 2.5, sugarPct: 1,
    leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
    ovenC: 300, surface: 'steel', ddt: 24,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  };
  const M = computeAll(inp);

  test('longer cold ferment needs less yeast than shorter cold ferment', () => {
    // More time = less yeast needed (K / hours); same cold temperature
    const shorter = computeAll({ ...inp, hours: 24 });
    assert.ok(M.r.grams < shorter.r.grams,
      `48h=${M.r.grams.toFixed(3)}g should be < 24h=${shorter.r.grams.toFixed(3)}g`);
  });
  test('no leoparding at 300 °C', () => assert.ok(!M.bake.leopard));
  test('digestibility boosted by cold', () => {
    const warmM = computeAll({ ...inp, tempC: 21 });
    assert.ok(M.digest > warmM.digest, 'cold ferment → higher digestibility');
  });
});

describe('computeAll — sourdough', () => {
  const inp = {
    tempC: 5, hours: 24, protein: 12.5, plVal: 50,
    hydration: 72, salt: 2.5, oilPct: 0, sugarPct: 0,
    leavening: 'sourdough', yeastType: 'idy', preferment: 'straight',
    ovenC: 270, surface: 'steel', ddt: 24,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 60,
  };
  const M = computeAll(inp);

  test('levainGrams > 0, commercial grams = 0', () => {
    assert.ok(M.r.levainGrams > 0);
    assert.equal(M.r.grams, 0);
  });
  test('digestibility higher than equivalent commercial', () => {
    const com = computeAll({ ...inp, leavening: 'commercial' });
    assert.ok(M.digest > com.digest, 'sourdough more digestible');
  });
});

describe('computeAll — over-prove scenario', () => {
  // Weak flour (10% protein, maxHours ≈ 12) left for 48h
  const inp = {
    ...BASE, protein: 10, hours: 48,
  };
  const M = computeAll(inp);

  test('proof quality degraded when over capacity', () => {
    assert.ok(M.proof < 1, `proofQuality=${M.proof.toFixed(2)} should be < 1`);
  });
  test('ferment verdict is bad', () => {
    assert.equal(M.verdicts.ferment.tone, 'bad');
  });
  test('rise model flags collapse', () => {
    assert.ok(M.rise.collapses, 'weak flour at 48h should collapse');
  });
  test('overProof included and non-null when over capacity', () => {
    assert.ok('overProof' in M, 'overProof key must be present');
    assert.ok(M.overProof !== null, 'over-proved scenario has non-null overProof');
  });
});

describe('computeAll — overProof null when well within capacity', () => {
  test('overProof is null at anchor conditions', () => {
    const M = computeAll(BASE); // protein=12, hours=8, maxHours=24 → raw=0.33
    assert.equal(M.overProof, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bakeProfile — style branches
// ─────────────────────────────────────────────────────────────────────────────

describe('bakeProfile — style branches', () => {
  test('Neapolitan style at ≥430 °C', () => {
    assert.equal(bakeProfile(460, 60, 2.5, 0, 0, 'stone').styleKey, 'bakeStyle.neapolitan');
    assert.equal(bakeProfile(430, 60, 2.5, 0, 0, 'stone').styleKey, 'bakeStyle.neapolitan');
  });
  test('Artisan / high-heat style at 340–429 °C', () => {
    assert.equal(bakeProfile(380, 60, 2.5, 0, 0, 'stone').styleKey, 'bakeStyle.artisan');
    assert.equal(bakeProfile(340, 60, 2.5, 0, 0, 'stone').styleKey, 'bakeStyle.artisan');
  });
  test('New York style at 280–339 °C', () => {
    assert.equal(bakeProfile(300, 60, 2.5, 0, 0, 'steel').styleKey, 'bakeStyle.ny');
    assert.equal(bakeProfile(280, 60, 2.5, 0, 0, 'steel').styleKey, 'bakeStyle.ny');
  });
  test('Home oven style at 240–279 °C', () => {
    assert.equal(bakeProfile(250, 60, 2.5, 0, 0, 'steel').styleKey, 'bakeStyle.homeOven');
    assert.equal(bakeProfile(240, 60, 2.5, 0, 0, 'steel').styleKey, 'bakeStyle.homeOven');
  });
  test('Low / pan style below 240 °C', () => {
    assert.equal(bakeProfile(200, 60, 2.5, 0, 0, 'pan').styleKey, 'bakeStyle.lowPan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// digestVerdict — all branches
// ─────────────────────────────────────────────────────────────────────────────

describe('digestVerdict', () => {
  test('d >= 68 → good tone', () => {
    assert.equal(digestVerdict(68).tone, 'good');
    assert.equal(digestVerdict(80).tone, 'good');
  });
  test('45 ≤ d < 68 → warn tone with moderate code', () => {
    const v = digestVerdict(50);
    assert.equal(v.tone, 'warn');
    assert.equal(v.code, 'verdict.digest.moderate');
    assert.equal(v.params.d, 50);
  });
  test('d < 45 → warn tone with short code', () => {
    const v = digestVerdict(30);
    assert.equal(v.tone, 'warn');
    assert.equal(v.code, 'verdict.digest.short');
    assert.equal(v.params.d, 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bakeVerdict — all branches
// ─────────────────────────────────────────────────────────────────────────────

describe('bakeVerdict', () => {
  test('leopard → good', () => {
    assert.equal(bakeVerdict({ leopard: true }, 460).tone, 'good');
  });
  test('no leopard at ≥430 °C → warn', () => {
    assert.equal(bakeVerdict({ leopard: false }, 430).tone, 'warn');
  });
  test('no leopard at 280–429 °C → good', () => {
    assert.equal(bakeVerdict({ leopard: false }, 300).tone, 'good');
    assert.equal(bakeVerdict({ leopard: false }, 280).tone, 'good');
  });
  test('no leopard at 240–279 °C → good', () => {
    assert.equal(bakeVerdict({ leopard: false }, 250).tone, 'good');
    assert.equal(bakeVerdict({ leopard: false }, 240).tone, 'good');
  });
  test('no leopard below 240 °C → warn', () => {
    assert.equal(bakeVerdict({ leopard: false }, 200).tone, 'warn');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compute — preferment factor and fresh-yeast tsp=null
// ─────────────────────────────────────────────────────────────────────────────

describe('compute — preferment and yeast-type branches', () => {
  test('preferment reduces yeast by 15% vs straight (pfYeast=0.85)', () => {
    const straight = compute({ ...BASE, preferment: 'straight' });
    const biga     = compute({ ...BASE, preferment: 'biga' });
    near(biga.pct, straight.pct * 0.85, 0.001, 'biga pct = straight × 0.85');
  });

  test('fresh yeast has null tsp (no volume conversion)', () => {
    const r = compute({ ...BASE, yeastType: 'fresh' });
    assert.equal(r.tsp, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// geometryFn
// ─────────────────────────────────────────────────────────────────────────────

describe('geometryFn', () => {
  test('returns the four required fields', () => {
    const g = geometryFn(65, 12, 300, 1, 0);
    assert.ok('openness' in g && 'strength' in g && 'springFrac' in g && 'rimIndex' in g);
  });

  test('higher hydration → more open crumb', () => {
    const lo = geometryFn(55, 12, 300, 1, 0);
    const hi = geometryFn(75, 12, 300, 1, 0);
    assert.ok(hi.openness > lo.openness);
  });

  test('higher protein → stronger dough', () => {
    const lo = geometryFn(65, 10, 300, 1, 0);
    const hi = geometryFn(65, 14, 300, 1, 0);
    assert.ok(hi.strength > lo.strength);
  });

  test('hotter oven → more oven spring', () => {
    const cool = geometryFn(65, 12, 230, 1, 0);
    const hot  = geometryFn(65, 12, 470, 1, 0);
    assert.ok(hot.springFrac > cool.springFrac);
  });

  test('openness and strength clamped to [0, 1]', () => {
    const g = geometryFn(65, 12, 300, 1, 0);
    assert.ok(g.openness >= 0 && g.openness <= 1);
    assert.ok(g.strength >= 0 && g.strength <= 1);
    assert.ok(g.springFrac >= 0 && g.springFrac <= 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRisePaths
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRisePaths', () => {
  const m   = riseModel(21, 8, 12);
  const pad = { l: 40, r: 20, t: 20, b: 30 };
  const P   = buildRisePaths(m, 400, 200, pad, 260);

  test('returns required keys: line, area, target, lagX, baselineY', () => {
    assert.ok('line' in P && 'area' in P && 'target' in P && 'lagX' in P && 'baselineY' in P);
  });
  test('line SVG path starts with M (moveto)', () => {
    assert.ok(P.line.trim().startsWith('M'), `line starts with: ${P.line.slice(0, 5)}`);
  });
  test('area SVG path closes with Z', () => {
    assert.ok(P.area.trim().endsWith('Z'), `area ends with: ${P.area.slice(-5)}`);
  });
  test('target.x and target.y are finite numbers', () => {
    assert.ok(Number.isFinite(P.target.x) && Number.isFinite(P.target.y));
  });
  test('lagX is between left pad and right edge', () => {
    assert.ok(P.lagX >= pad.l && P.lagX <= 400 - pad.r);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// overProofRecommendations — all branches
// ─────────────────────────────────────────────────────────────────────────────

describe('overProofRecommendations', () => {
  // protein=12, maxHours=24
  const fp12 = flourProfile(12, 0);

  const baseInp = { ...BASE, protein: 12, tempC: 21, salt: 2.5, preferment: 'straight', hydration: 60 };

  test('returns null when raw < 0.8 (hours well under capacity)', () => {
    const r = overProofRecommendations({ ...baseInp, hours: 10 }, fp12); // 10/24 ≈ 0.42
    assert.equal(r, null);
  });

  test('returns null at exactly 79% of capacity', () => {
    const r = overProofRecommendations({ ...baseInp, hours: 19 }, fp12); // 19/24 ≈ 0.79
    assert.equal(r, null);
  });

  test('caution severity at 80–99% of capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 20 }, fp12); // 20/24 ≈ 0.83
    assert.equal(op.severity, 'caution');
    assert.equal(op.labelCode, 'overproof.caution');
  });

  test('warn severity at 100–124% of capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12); // 26/24 ≈ 1.08
    assert.equal(op.severity, 'warn');
    assert.equal(op.labelCode, 'overproof.warn');
  });

  test('bad severity at ≥125% of capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 32 }, fp12); // 32/24 ≈ 1.33
    assert.equal(op.severity, 'bad');
    assert.equal(op.labelCode, 'overproof.bad');
  });

  test('raw field equals hours / maxHours', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 20 }, fp12);
    near(op.raw, 20 / 24, 0.001, 'raw = hours / maxHours');
  });

  test('why text mentions headroom when below capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 20 }, fp12);
    assert.equal(op.whyCode, 'overproof.why.near');
    assert.ok(op.whyParams.headroom > 0, JSON.stringify(op.whyParams));
  });

  test('why text mentions collapsing when at/over capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12);
    assert.equal(op.whyCode, 'overproof.why.over');
  });

  // ── lever conditions ──

  test('protein lever appears when protein < 13', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, protein: 12 }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.proteinKey'));
  });

  test('protein lever absent when protein >= 13', () => {
    const fp13 = flourProfile(13, 0);
    const op   = overProofRecommendations({ ...baseInp, hours: 40, protein: 13 }, fp13);
    assert.ok(!op.levers.some(l => l.kCode === 'overproof.lever.proteinKey'));
  });

  test('temperature lever appears when tempC > 10', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, tempC: 20 }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.temperatureKey'));
  });

  test('temperature lever absent when tempC <= 10', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, tempC: 8 }, fp12);
    assert.ok(!op.levers.some(l => l.kCode === 'overproof.lever.temperatureKey'));
  });

  test('salt lever appears when salt < 2.5', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, salt: 2.0 }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.saltKey'));
  });

  test('salt lever absent when salt >= 2.5', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, salt: 2.5 }, fp12);
    assert.ok(!op.levers.some(l => l.kCode === 'overproof.lever.saltKey'));
  });

  test('time lever is always present', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.timeKey'));
  });

  test('preferment lever appears for straight dough', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'straight' }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
  });

  test('preferment lever absent for biga or poolish', () => {
    const opBiga   = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'biga' },   fp12);
    const opPoolish = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'poolish' }, fp12);
    assert.ok(!opBiga.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
    assert.ok(!opPoolish.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
  });

  test('hydration lever appears when hydration > 68', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, hydration: 70 }, fp12);
    assert.ok(op.levers.some(l => l.kCode === 'overproof.lever.hydrationKey'));
  });

  test('hydration lever absent when hydration <= 68', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, hydration: 65 }, fp12);
    assert.ok(!op.levers.some(l => l.kCode === 'overproof.lever.hydrationKey'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flour analyser
// ─────────────────────────────────────────────────────────────────────────────

describe('wFromProtein / plToSlider / absorptionFromFlour', () => {
  test('W mirrors flourProfile — (protein−6)×40, clamped', () => {
    assert.equal(wFromProtein(12.5), 260);
    assert.equal(wFromProtein(12.5), flourProfile(12.5, 0).W);
    assert.equal(wFromProtein(4), 60);
    assert.equal(wFromProtein(20), 400);
  });

  test('a printed P/L maps onto the 0–100 extensible↔elastic slider', () => {
    assert.equal(plToSlider(0.55), 50);   // the balanced middle
    assert.equal(plToSlider(1.0), 100);   // fully elastic
    assert.equal(plToSlider(0.1), 0);     // fully extensible
    assert.ok(plToSlider(0.75) > 50);
    assert.ok(plToSlider(0.40) < 50);
  });

  test('plToSlider clamps beyond the slider ends', () => {
    assert.equal(plToSlider(2.5), 100);
    assert.equal(plToSlider(0.01), 0);
  });

  test('estimated absorption rises with protein, and again with bran', () => {
    assert.ok(absorptionFromFlour(14, null) > absorptionFromFlour(10, null));
    assert.ok(absorptionFromFlour(13, 1.5) > absorptionFromFlour(13, 0.5));
    assert.equal(absorptionFromFlour(13, 0.5), absorptionFromFlour(13, null)); // no bran below 0.6% ash
  });
});

describe('bandScore', () => {
  test('inside the range scores 1', () => assert.equal(bandScore(12, 11, 13), 1));
  test('within half a width either side scores 0.5', () => {
    assert.equal(bandScore(13.9, 11, 13), 0.5);
    assert.equal(bandScore(10.1, 11, 13), 0.5);
  });
  test('beyond that scores 0', () => {
    assert.equal(bandScore(15, 11, 13), 0);
    assert.equal(bandScore(9, 11, 13), 0);
  });
});

describe('analyseFlour — inputs', () => {
  test('no usable protein figure → null', () => {
    assert.equal(analyseFlour({}), null);
    assert.equal(analyseFlour(null), null);
    assert.equal(analyseFlour({ protein: 'not a number' }), null);
    assert.equal(analyseFlour({ w: 300 }), null); // W alone isn't enough
  });

  test('numeric strings from text inputs are accepted', () => {
    const typed = analyseFlour({ protein: ' 12.5 ', w: '300', pl: '0.60' });
    const numeric = analyseFlour({ protein: 12.5, w: 300, pl: 0.6 });
    assert.deepEqual(typed.suggest, numeric.suggest);
    assert.equal(typed.W, 300);
  });

  test('protein alone still analyses, marking everything else estimated', () => {
    const a = analyseFlour({ protein: 12.5 });
    assert.equal(a.wEstimated, true);
    assert.equal(a.plEstimated, true);
    assert.equal(a.absorptionEstimated, true);
    assert.equal(a.W, wFromProtein(12.5));
  });

  test('a printed W wins over the protein estimate', () => {
    const a = analyseFlour({ protein: 11, w: 320 });
    assert.equal(a.W, 320);
    assert.equal(a.wEstimated, false);
    // and drives the strength read, not the 11% protein
    assert.equal(a.categoryKey, 'flour.veryStrong');
  });

  test('protein-only matches the calculator’s own flour profile', () => {
    const a = analyseFlour({ protein: 13 });
    const fp = flourProfile(13, 0);
    assert.equal(a.W, fp.W);
    assert.equal(a.hydrLo, fp.hydrLo);
    assert.equal(a.hydrHi, fp.hydrHi);
    near(a.maxHours, fp.maxHours, 1e-9);
  });

  test('a printed absorption anchors the hydration window', () => {
    const a = analyseFlour({ protein: 12.5, absorption: 70 });
    assert.equal(a.absorptionEstimated, false);
    assert.equal(a.hydrLo, 66);
    assert.equal(a.hydrHi, 74);
  });

  test('out-of-range entries are clamped, not rejected', () => {
    const a = analyseFlour({ protein: 99, w: 9999, pl: -5 });
    assert.equal(a.protein, 20);
    assert.equal(a.W, 500);
    assert.equal(a.pl, 0.1);
  });
});

describe('analyseFlour — ferment capacity', () => {
  test('high amylase (low falling number) shortens the safe prove', () => {
    const plain = analyseFlour({ protein: 13 });
    const enzymey = analyseFlour({ protein: 13, fallingNumber: 200 });
    assert.ok(enzymey.maxHours < plain.maxHours);
    near(enzymey.maxHours, plain.maxHours * 0.8, 1e-9);
  });

  test('a sluggish, high falling number buys a little more', () => {
    const plain = analyseFlour({ protein: 13 });
    const sluggish = analyseFlour({ protein: 13, fallingNumber: 400 });
    assert.ok(sluggish.maxHours > plain.maxHours);
  });

  test('a mid falling number leaves capacity untouched', () => {
    near(analyseFlour({ protein: 13, fallingNumber: 300 }).maxHours,
         analyseFlour({ protein: 13 }).maxHours, 1e-9);
  });

  test('bran cuts capacity; fine white flour does not', () => {
    const white = analyseFlour({ protein: 13, ash: 0.5 });
    const high = analyseFlour({ protein: 13, ash: 1.0 });
    const wholemeal = analyseFlour({ protein: 13, ash: 1.6 });
    near(white.maxHours, analyseFlour({ protein: 13 }).maxHours, 1e-9);
    assert.ok(high.maxHours < white.maxHours);
    assert.ok(wholemeal.maxHours < high.maxHours);
  });
});

describe('analyseFlour — findings', () => {
  const codes = (a) => a.findings.map((f) => f.code);

  test('every flour gets exactly one strength read', () => {
    [8, 10, 12.5, 15, 18].forEach((protein) => {
      const strengths = codes(analyseFlour({ protein })).filter((c) => c.startsWith('flourFind.strength.'));
      assert.equal(strengths.length, 1, `protein ${protein}`);
    });
  });

  test('strength bands follow W', () => {
    assert.ok(codes(analyseFlour({ protein: 10, w: 150 })).includes('flourFind.strength.weak'));
    assert.ok(codes(analyseFlour({ protein: 11, w: 200 })).includes('flourFind.strength.medium'));
    assert.ok(codes(analyseFlour({ protein: 13, w: 300 })).includes('flourFind.strength.strong'));
    assert.ok(codes(analyseFlour({ protein: 15, w: 380 })).includes('flourFind.strength.veryStrong'));
  });

  test('a weak flour is flagged warn, a pizza-strength one good', () => {
    const weak = analyseFlour({ protein: 9 }).findings[0];
    const strong = analyseFlour({ protein: 13 }).findings[0];
    assert.equal(weak.tone, 'warn');
    assert.equal(strong.tone, 'good');
  });

  test('W above what the protein predicts reads as gluten quality', () => {
    const a = analyseFlour({ protein: 11, w: 320 }); // predicts 200
    assert.ok(codes(a).includes('flourFind.quality.high'));
  });

  test('W below what the protein predicts is a warning', () => {
    const a = analyseFlour({ protein: 14, w: 180 }); // predicts 320
    const f = a.findings.find((x) => x.code === 'flourFind.quality.low');
    assert.ok(f);
    assert.equal(f.tone, 'warn');
  });

  test('no quality finding when W and protein agree, or when W is estimated', () => {
    assert.ok(!codes(analyseFlour({ protein: 12.5, w: 260 })).includes('flourFind.quality.high'));
    assert.ok(!codes(analyseFlour({ protein: 12.5, w: 260 })).includes('flourFind.quality.low'));
    assert.ok(!codes(analyseFlour({ protein: 12.5 })).some((c) => c.startsWith('flourFind.quality.')));
  });

  test('P/L bands, and nothing said when the bag omits it', () => {
    assert.ok(codes(analyseFlour({ protein: 13, pl: 1.1 })).includes('flourFind.pl.veryElastic'));
    assert.ok(codes(analyseFlour({ protein: 13, pl: 0.7 })).includes('flourFind.pl.elastic'));
    assert.ok(codes(analyseFlour({ protein: 13, pl: 0.55 })).includes('flourFind.pl.balanced'));
    assert.ok(codes(analyseFlour({ protein: 13, pl: 0.35 })).includes('flourFind.pl.extensible'));
    assert.ok(!codes(analyseFlour({ protein: 13 })).some((c) => c.startsWith('flourFind.pl.')));
  });

  test('ash bands, and nothing said when the bag omits it', () => {
    assert.ok(codes(analyseFlour({ protein: 13, ash: 0.5 })).includes('flourFind.ash.fine'));
    assert.ok(codes(analyseFlour({ protein: 13, ash: 0.7 })).includes('flourFind.ash.mid'));
    assert.ok(codes(analyseFlour({ protein: 13, ash: 1.0 })).includes('flourFind.ash.high'));
    assert.ok(codes(analyseFlour({ protein: 13, ash: 1.6 })).includes('flourFind.ash.wholemeal'));
    assert.ok(!codes(analyseFlour({ protein: 13 })).some((c) => c.startsWith('flourFind.ash.')));
  });

  test('falling-number bands, and nothing said when the bag omits it', () => {
    assert.ok(codes(analyseFlour({ protein: 13, fallingNumber: 200 })).includes('flourFind.falling.low'));
    assert.ok(codes(analyseFlour({ protein: 13, fallingNumber: 300 })).includes('flourFind.falling.ok'));
    assert.ok(codes(analyseFlour({ protein: 13, fallingNumber: 420 })).includes('flourFind.falling.high'));
    assert.ok(!codes(analyseFlour({ protein: 13 })).some((c) => c.startsWith('flourFind.falling.')));
  });

  test('a thirsty flour reads as an absorption strength, a mean one as a warning', () => {
    const thirsty = analyseFlour({ protein: 12, absorption: 70 });
    const mean = analyseFlour({ protein: 12, absorption: 54 });
    assert.ok(codes(thirsty).includes('flourFind.absorption.high'));
    assert.equal(mean.findings.find((f) => f.code === 'flourFind.absorption.low').tone, 'warn');
  });

  test('every finding carries a tone the UI knows how to colour', () => {
    const a = analyseFlour({ protein: 12.5, w: 300, pl: 0.6, ash: 0.5, absorption: 62, fallingNumber: 300 });
    a.findings.forEach((f) => assert.ok(['good', 'warn', 'bad'].includes(f.tone), f.code));
    assert.equal(a.findings.length, 5); // strength, P/L, absorption, ash, falling number
  });
});

describe('analyseFlour — style fit', () => {
  test('scores every built-in style, best first', () => {
    const a = analyseFlour({ protein: 12.5 });
    assert.equal(a.styleFit.length, Object.keys(STYLE_GUIDELINES).length);
    for (let i = 1; i < a.styleFit.length; i++) {
      assert.ok(a.styleFit[i - 1].score >= a.styleFit[i].score);
    }
  });

  test('scores stay in [0, 1] and tones follow them', () => {
    [8, 10, 12.5, 14, 18].forEach((protein) => {
      analyseFlour({ protein }).styleFit.forEach((s) => {
        assert.ok(s.score >= 0 && s.score <= 1, `${s.id} ${s.score}`);
        const expected = s.score >= 0.8 ? 'good' : s.score >= 0.5 ? 'warn' : 'bad';
        assert.equal(s.tone, expected);
      });
    });
  });

  test('a pizza-strength flour suits at least one style; a cake flour suits none', () => {
    assert.ok(analyseFlour({ protein: 12.5 }).bestStyles.length > 0);
    assert.equal(analyseFlour({ protein: 8 }).bestStyles.length, 0);
  });

  test('a good fit says so; a poor one names its weakest dimension', () => {
    analyseFlour({ protein: 12.5 }).styleFit.forEach((s) => {
      if (s.tone === 'good') assert.equal(s.reasonCode, 'flourFit.reason.suits');
      else assert.ok(['protein', 'ferment', 'hydration', 'pl'].includes(s.reasonCode.split('.').pop()));
    });
  });

  test('a flour that cannot hold the prove is limited by ferment, not protein', () => {
    // right protein for New York, but the enzymes burn it out long before 24 h
    const a = analyseFlour({ protein: 12.5, fallingNumber: 150, ash: 1.6 });
    const ny = a.styleFit.find((s) => s.id === 'ny');
    assert.equal(ny.reasonCode, 'flourFit.reason.ferment');
    assert.ok(ny.reasonParams.maxH < 24);
  });

  test('P/L only counts toward the fit when the bag prints it', () => {
    const without = analyseFlour({ protein: 12.5 });
    const elastic = analyseFlour({ protein: 12.5, pl: 1.2 });
    const roman = (a) => a.styleFit.find((s) => s.id === 'roman').score;
    assert.ok(roman(elastic) < roman(without)); // far too springy to stretch into a tray
    assert.ok(!without.styleFit.some((s) => s.reasonCode === 'flourFit.reason.pl'));
  });

  test('summary tracks the best fit found', () => {
    assert.equal(analyseFlour({ protein: 12.5 }).summary.code, 'flourSummary.good');
    assert.equal(analyseFlour({ protein: 8 }).summary.code, 'flourSummary.weak');
    assert.ok(['flourSummary.good', 'flourSummary.mixed', 'flourSummary.weak']
      .includes(analyseFlour({ protein: 11 }).summary.code));
  });

  test('every style has a P/L preference range to score against', () => {
    Object.keys(STYLE_GUIDELINES).forEach((id) => {
      const range = STYLE_PL_RANGE[id];
      assert.ok(Array.isArray(range) && range[0] < range[1], id);
    });
  });
});

describe('analyseFlour — handing values back to the calculator', () => {
  test('suggested values land on the calculator’s own slider ranges and steps', () => {
    [5, 9, 12.3, 13.7, 20].forEach((protein) => {
      const s = analyseFlour({ protein, absorption: 95 }).suggest;
      assert.ok(s.protein >= 8 && s.protein <= 15);
      assert.equal(s.protein * 2, Math.round(s.protein * 2)); // 0.5 steps
      assert.ok(s.plVal >= 0 && s.plVal <= 100);
      assert.ok(s.hydration >= 50 && s.hydration <= 85);
      assert.equal(s.hydration, Math.round(s.hydration));
    });
  });

  test('suggested P/L is the middle of the slider when the bag omits it', () => {
    assert.equal(analyseFlour({ protein: 12.5 }).suggest.plVal, 50);
  });

  test('suggested hydration sits in the middle of the reported window', () => {
    const a = analyseFlour({ protein: 12.5, absorption: 70 });
    assert.equal(a.suggest.hydration, 70);
    assert.ok(a.suggest.hydration >= a.hydrLo && a.suggest.hydration <= a.hydrHi);
  });
});

describe('FLOUR_FIELDS', () => {
  test('protein is the only required field', () => {
    assert.deepEqual(FLOUR_FIELDS.filter((f) => f.required).map((f) => f.key), ['protein']);
  });

  test('every field has a sane min/max/step', () => {
    FLOUR_FIELDS.forEach((f) => {
      assert.ok(f.min < f.max, f.key);
      assert.ok(f.step > 0, f.key);
    });
  });

  test('field bounds match what analyseFlour clamps to', () => {
    const maxed = {}, minned = {};
    FLOUR_FIELDS.forEach((f) => { maxed[f.key] = f.max * 10; minned[f.key] = f.min / 10; });
    const hi = analyseFlour(maxed), lo = analyseFlour(minned);
    FLOUR_FIELDS.forEach((f) => {
      const read = { protein: 'protein', w: 'W', pl: 'pl', fallingNumber: 'fallingNumber', ash: 'ash' }[f.key];
      if (!read) return;
      assert.equal(hi[read], f.max, f.key);
      assert.equal(lo[read], f.min, f.key);
    });
  });
});

describe('analyseFlour — blank fields', () => {
  test('a blank string is absent, not zero clamped to the field minimum', () => {
    const blanks = analyseFlour({ protein: 12.5, w: '', pl: '', ash: '', absorption: '', fallingNumber: '  ' });
    const omitted = analyseFlour({ protein: 12.5 });
    assert.equal(blanks.wEstimated, true);
    assert.equal(blanks.plEstimated, true);
    assert.equal(blanks.absorptionEstimated, true);
    assert.equal(blanks.ash, null);
    assert.equal(blanks.fallingNumber, null);
    assert.deepEqual(blanks.findings, omitted.findings);
    assert.deepEqual(blanks.suggest, omitted.suggest);
  });

  test('a blank protein is still no analysis', () => {
    assert.equal(analyseFlour({ protein: '' }), null);
    assert.equal(analyseFlour({ protein: '   ', w: '300' }), null);
  });

  test('a real zero is still clamped to the field minimum', () => {
    assert.equal(analyseFlour({ protein: 12.5, ash: 0 }).ash, 0.2);
  });
});
