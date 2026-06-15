// Unit tests for the pizza dough calculation engine.
// Run: node --test doughEngine.test.js
// No build step, no npm — uses Node 18+ built-in test runner.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
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
    assert.equal(flourProfile(9.5, 0).category, 'Soft / weak');
    assert.equal(flourProfile(11, 0).category, 'Medium');
    assert.equal(flourProfile(12.5, 0).category, 'Strong (pizza)');
    assert.equal(flourProfile(14, 0).category, 'Very strong');
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
// fmtBake / crustLabel helpers
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

describe('crustLabel', () => {
  test('< 30 → pale', () => assert.ok(crustLabel(20).includes('ale')));
  test('30-55 → golden', () => assert.ok(crustLabel(40).toLowerCase().includes('golden')));
  test('55-78 → deep golden', () => assert.ok(crustLabel(70).toLowerCase().includes('deep')));
  test('≥ 78 → charred', () => assert.ok(crustLabel(90).toLowerCase().includes('charred')));
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
    assert.equal(bakeProfile(460, 60, 2.5, 0, 0, 'stone').style, 'Neapolitan');
    assert.equal(bakeProfile(430, 60, 2.5, 0, 0, 'stone').style, 'Neapolitan');
  });
  test('Artisan / high-heat style at 340–429 °C', () => {
    assert.equal(bakeProfile(380, 60, 2.5, 0, 0, 'stone').style, 'Artisan / high-heat');
    assert.equal(bakeProfile(340, 60, 2.5, 0, 0, 'stone').style, 'Artisan / high-heat');
  });
  test('New York style at 280–339 °C', () => {
    assert.equal(bakeProfile(300, 60, 2.5, 0, 0, 'steel').style, 'New York');
    assert.equal(bakeProfile(280, 60, 2.5, 0, 0, 'steel').style, 'New York');
  });
  test('Home oven style at 240–279 °C', () => {
    assert.equal(bakeProfile(250, 60, 2.5, 0, 0, 'steel').style, 'Home oven');
    assert.equal(bakeProfile(240, 60, 2.5, 0, 0, 'steel').style, 'Home oven');
  });
  test('Low / pan style below 240 °C', () => {
    assert.equal(bakeProfile(200, 60, 2.5, 0, 0, 'pan').style, 'Low / pan');
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
  test('45 ≤ d < 68 → warn tone with "Moderate" text', () => {
    const v = digestVerdict(50);
    assert.equal(v.tone, 'warn');
    assert.ok(v.text.toLowerCase().includes('moderate'), v.text);
  });
  test('d < 45 → warn tone with "Short" text', () => {
    const v = digestVerdict(30);
    assert.equal(v.tone, 'warn');
    assert.ok(v.text.toLowerCase().includes('short'), v.text);
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
    assert.equal(op.label, 'Approaching limit');
  });

  test('warn severity at 100–124% of capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12); // 26/24 ≈ 1.08
    assert.equal(op.severity, 'warn');
    assert.equal(op.label, 'Exceeds capacity');
  });

  test('bad severity at ≥125% of capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 32 }, fp12); // 32/24 ≈ 1.33
    assert.equal(op.severity, 'bad');
    assert.equal(op.label, 'Over-proved');
  });

  test('raw field equals hours / maxHours', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 20 }, fp12);
    near(op.raw, 20 / 24, 0.001, 'raw = hours / maxHours');
  });

  test('why text mentions headroom when below capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 20 }, fp12);
    assert.ok(op.why.toLowerCase().includes('headroom'), op.why);
  });

  test('why text mentions collapsing when at/over capacity', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12);
    assert.ok(op.why.toLowerCase().includes('collapses') || op.why.toLowerCase().includes('rupture'), op.why);
  });

  // ── lever conditions ──

  test('protein lever appears when protein < 13', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, protein: 12 }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Flour protein'));
  });

  test('protein lever absent when protein >= 13', () => {
    const fp13 = flourProfile(13, 0);
    const op   = overProofRecommendations({ ...baseInp, hours: 40, protein: 13 }, fp13);
    assert.ok(!op.levers.some(l => l.k === 'Flour protein'));
  });

  test('temperature lever appears when tempC > 10', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, tempC: 20 }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Temperature'));
  });

  test('temperature lever absent when tempC <= 10', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, tempC: 8 }, fp12);
    assert.ok(!op.levers.some(l => l.k === 'Temperature'));
  });

  test('salt lever appears when salt < 2.5', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, salt: 2.0 }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Salt'));
  });

  test('salt lever absent when salt >= 2.5', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, salt: 2.5 }, fp12);
    assert.ok(!op.levers.some(l => l.k === 'Salt'));
  });

  test('time lever is always present', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26 }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Time'));
  });

  test('preferment lever appears for straight dough', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'straight' }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Preferment'));
  });

  test('preferment lever absent for biga or poolish', () => {
    const opBiga   = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'biga' },   fp12);
    const opPoolish = overProofRecommendations({ ...baseInp, hours: 26, preferment: 'poolish' }, fp12);
    assert.ok(!opBiga.levers.some(l => l.k === 'Preferment'));
    assert.ok(!opPoolish.levers.some(l => l.k === 'Preferment'));
  });

  test('hydration lever appears when hydration > 68', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, hydration: 70 }, fp12);
    assert.ok(op.levers.some(l => l.k === 'Hydration'));
  });

  test('hydration lever absent when hydration <= 68', () => {
    const op = overProofRecommendations({ ...baseInp, hours: 26, hydration: 65 }, fp12);
    assert.ok(!op.levers.some(l => l.k === 'Hydration'));
  });
});
