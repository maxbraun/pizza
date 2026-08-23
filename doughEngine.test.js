// Unit tests for the pizza dough calculation engine.
// Run: node --test doughEngine.test.js
// No build step, no npm — uses Node 18+ built-in test runner.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  clamp,
  fermentStages,
  fermentProfile,
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
  REF, K, Q10, Q10_MATURE, TRANSITION_H, SALT_REF, TYPE, SURF, FRICTION,
} = require('./doughEngine.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Assert a number is within ±delta of expected
function near(actual, expected, delta = 0.01, msg) {
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= delta, `${msg ?? ''} expected ${actual} ≈ ${expected} (±${delta}), diff=${diff.toFixed(4)}`);
}

// Single-zone profile at a steady temperature (dough starts at that temp,
// so no equilibration segment — both clocks run linearly)
const constProf = (hours, tempC = 21) => fermentProfile([{ tempC, hours }], tempC);
// Profile exactly as computeAll builds it from calculator inputs
const profFor = (inp) => fermentProfile(fermentStages(inp), inp.ddt);

// Default inputs that match the Q10 anchor (21 °C, 8 h, IDY, 2.5% salt).
// ddt equals tempC so no mix→ferment equilibration segment kicks in and
// the anchor arithmetic stays exact.
const BASE = {
  tempC: 21, hours: 8, protein: 12, plVal: 50,
  hydration: 60, salt: 2.5, oilPct: 0, sugarPct: 0,
  leavening: 'commercial', yeastType: 'idy', starterStr: 50,
  preferment: 'straight', roomTemp: 20, ddt: 21,
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
    assert.equal(fermentVerdict(constProf(12), fp).tone, 'good');
  });

  test('slightly over → warn', () => {
    assert.equal(fermentVerdict(constProf(fp.maxHours + 1), fp).tone, 'warn');
  });

  test('more than 25% over → bad', () => {
    assert.equal(fermentVerdict(constProf(Math.ceil(fp.maxHours * 1.26)), fp).tone, 'bad');
  });

  test('at 21 °C the reported capacity is maxHours itself', () => {
    assert.equal(fermentVerdict(constProf(12), fp).params.m, Math.round(fp.maxHours));
  });

  test('cold schedule spends capacity slowly → same wall-clock hours stay good', () => {
    // 30 h would exceed maxHours=24 at room temp, but at 4 °C the maturation
    // clock runs at ~0.4×, so the same wall-clock time reads comfortable
    assert.equal(fermentVerdict(constProf(30, 21), fp).tone, 'warn');
    assert.equal(fermentVerdict(constProf(30, 4), fp).tone, 'good');
  });

  test('reported wall-clock capacity stretches in the fridge', () => {
    const warm = fermentVerdict(constProf(12, 21), fp).params.m;
    const cold = fermentVerdict(constProf(12, 4), fp).params.m;
    assert.ok(cold > warm, `cold capacity ${cold}h should exceed warm ${warm}h`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fermentProfile — two-zone schedules and the two clocks
// ─────────────────────────────────────────────────────────────────────────────

describe('fermentProfile', () => {
  test('steady 21 °C: both clocks equal wall-clock time', () => {
    const p = constProf(8, 21);
    near(p.gasUnits, 8, 1e-9);
    near(p.matureUnits, 8, 1e-9);
    near(p.gasAt(3), 3, 1e-9);
    near(p.matureAt(3), 3, 1e-9);
  });

  test('splitting a steady-temperature schedule changes nothing', () => {
    const whole = fermentProfile([{ tempC: 21, hours: 8 }], 21);
    const split = fermentProfile([{ tempC: 21, hours: 6 }, { tempC: 21, hours: 2 }], 21);
    near(split.gasUnits, whole.gasUnits, 1e-9);
    near(split.matureUnits, whole.matureUnits, 1e-9);
  });

  test('gas clock follows Q10 at a steady temperature', () => {
    const p = constProf(10, 11); // 10° below anchor
    near(p.gasUnits, 10 / Q10, 1e-9, 'Q10 slowdown');
    near(constProf(10, 31).gasUnits, 10 * Q10, 1e-9, 'Q10 speedup');
  });

  test('maturation clock runs on the flatter Q10_MATURE', () => {
    const p = constProf(10, 11);
    near(p.matureUnits, 10 / Q10_MATURE, 1e-9);
  });

  test('in the cold the maturation clock outpaces the gas clock', () => {
    const p = constProf(48, 4);
    assert.ok(p.matureUnits > p.gasUnits, 'enzymes slow less than yeast in the fridge');
    assert.ok(p.matureUnits < 48, 'but still slower than the wall clock');
  });

  test('warm dough entering the fridge earns a cool-down credit', () => {
    const equilibrated = fermentProfile([{ tempC: 4, hours: 24 }], 4);
    const offTheMixer  = fermentProfile([{ tempC: 4, hours: 24 }], 24);
    assert.ok(offTheMixer.gasUnits > equilibrated.gasUnits,
      'first hours ferment above fridge temperature while the core cools');
  });

  test('a ball proof entered cold contributes less than its face value', () => {
    const bulkOnly = fermentProfile([{ tempC: 4, hours: 46 }], 24);
    const twoStage = fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24);
    const stage2 = twoStage.gasUnits - bulkOnly.gasUnits;
    assert.ok(stage2 > 0, 'warm stage adds budget');
    assert.ok(stage2 < 2, `2 h at nominal 21 °C after the fridge is worth <2 h at 21 °C (got ${stage2.toFixed(2)})`);
  });

  test('wallAtMature inverts matureAt, including past the schedule end', () => {
    const p = fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24);
    for (const x of [1, 10, 30, 47, 60]) near(p.wallAtMature(p.matureAt(x)), x, 1e-6, `t=${x}`);
  });

  test('interior stage boundaries are reported in wall-clock hours', () => {
    const p = fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24);
    assert.deepEqual(p.boundaries, [46]);
    assert.deepEqual(constProf(8).boundaries, []);
  });

  test('endTemp: a full warm ball stage takes the chill off, a cold-only schedule does not', () => {
    const twoStage = fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: TRANSITION_H }], 24);
    near(twoStage.endTemp, 21, 0.01);
    const coldOnly = fermentProfile([{ tempC: 4, hours: 48 }], 24);
    near(coldOnly.endTemp, 4, 0.01);
    const briefBalls = fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 1 }], 24);
    assert.ok(briefBalls.endTemp > 4 && briefBalls.endTemp < 21, 'half the window → mid warm-up');
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
    // Use exactly 10°C apart, dough mixed to ferment temp so no equilibration
    const cold = compute({ ...BASE, tempC: 16, ddt: 16 });
    const warm = compute({ ...BASE, tempC: 26, ddt: 26 });
    assert.ok(warm.idyPct < cold.idyPct, 'warmer needs less yeast');
    // Q10=3 means +10°C → 3× faster yeast → 1/3 as much yeast
    near(warm.idyPct, cold.idyPct / Q10, 0.001, 'exact Q10 ratio');
  });

  test('two-zone dose divides by the summed budget of both stages', () => {
    const inp = { ...BASE, tempC: 4, ddt: 4, hours: 46, split: true, temp2C: 21, hours2: 2 };
    const r = compute(inp);
    const p = profFor(inp);
    near(r.idyPct, K / p.gasUnits, 0.0001, 'idy = K / gas budget at 2.5% salt');
  });

  test('adding a warm ball stage after the fridge lowers the dose', () => {
    const bulkOnly = compute({ ...BASE, tempC: 4, hours: 46 });
    const twoStage = compute({ ...BASE, tempC: 4, hours: 46, split: true, temp2C: 21, hours2: 2 });
    assert.ok(twoStage.idyPct < bulkOnly.idyPct, 'extra warm hours = more budget = less yeast');
  });

  test('split flag without hours2 falls back to a single stage', () => {
    const single = compute({ ...BASE });
    const noBall = compute({ ...BASE, split: true, temp2C: 21, hours2: 0 });
    near(noBall.idyPct, single.idyPct, 1e-9);
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
    const m = riseModel(constProf(8), 12);
    near(m.vAt(0), 100, 2, 'rise at t=0');
  });

  test('rise at target hours > 100%', () => {
    const m = riseModel(constProf(8), 12);
    assert.ok(m.vAt(8) > 100, `rise at 8h = ${m.vAt(8).toFixed(1)}%`);
  });

  test('peak rise Arise scales with protein', () => {
    const low  = riseModel(constProf(8), 10);
    const high = riseModel(constProf(8), 14);
    assert.ok(high.Arise > low.Arise, 'stronger flour → higher peak rise');
  });

  test('warmer temperature shortens lag (lagFrac decreases)', () => {
    const cold = riseModel(constProf(24, 4),  12);
    const warm = riseModel(constProf(24, 24), 12);
    assert.ok(warm.lambda < cold.lambda, 'warm → shorter lag');
  });

  test('dough collapses after maxHours at t > maxHours', () => {
    const m = riseModel(constProf(8), 9); // protein=9, maxHours≈8 (clamped)
    // At well past maxHours, dough should have decayed
    const atMax  = m.vAt(m.maxHours);
    const atOver = m.vAt(m.maxHours * 2);
    assert.ok(atOver < atMax, 'dough decays after maxHours');
  });

  test('collapses flag set when target hours > maxHours', () => {
    const m = riseModel(constProf(20), 9); // hours=20 >> maxHours=8
    assert.ok(m.collapses, 'should flag collapse');
  });

  test('dose and curve agree: the dough finishes proving at the schedule end', () => {
    // Whatever the schedule, gasUnits is the budget the yeast dose was sized
    // for, so the curve should be near its plateau exactly at totalHours
    for (const p of [constProf(8, 21), fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24)]) {
      const m = riseModel(p, 13);
      const frac = (m.vAt(p.totalHours) - 100) / m.Arise;
      assert.ok(frac > 0.9, `rise at schedule end = ${(frac * 100).toFixed(0)}% of peak`);
    }
  });

  test('two-zone curve: the fridge stretches the sigmoid flat, the warm stage steepens it', () => {
    // Same budget spent all-warm vs cold-bulk-first: halfway through the
    // wall clock the cold schedule has risen far less
    const coldSplit = riseModel(fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24), 13);
    const halfway = (coldSplit.vAt(24) - 100) / (coldSplit.vAt(48) - 100);
    const warm = riseModel(constProf(8, 21), 13);
    const warmHalf = (warm.vAt(4) - 100) / (warm.vAt(8) - 100);
    assert.ok(Number.isFinite(halfway) && halfway > 0 && halfway < 1);
    assert.ok(Number.isFinite(warmHalf));
    // and the curve keeps climbing through the warm ball stage
    assert.ok(coldSplit.vAt(48) > coldSplit.vAt(46), 'ball stage adds rise');
  });

  test('boundaries pass through for the view', () => {
    const m = riseModel(fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24), 13);
    assert.deepEqual(m.boundaries, [46]);
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
    for (const [u, l, p] of [
      [2, 'commercial', 'straight'],
      [72, 'sourdough', 'poolish'],
      [8, 'commercial', 'biga'],
    ]) {
      const d = digestScore(u, l, p);
      assert.ok(d >= 5 && d <= 99, `digestScore(${u},${l},${p})=${d}`);
    }
  });

  test('sourdough boosts score by 22', () => {
    const com = digestScore(8, 'commercial', 'straight');
    const sd  = digestScore(8, 'sourdough',  'straight');
    assert.equal(sd - com, 22);
  });

  test('preferment boosts score by 8', () => {
    const straight = digestScore(8, 'commercial', 'straight');
    const poolish  = digestScore(8, 'commercial', 'poolish');
    assert.equal(poolish - straight, 8);
  });

  test('more maturation-clock time increases score', () => {
    const short = digestScore(4,  'commercial', 'straight');
    const long  = digestScore(48, 'commercial', 'straight');
    assert.ok(long > short, 'longer maturation → higher digestibility');
  });

  test('for the same rise, cold fermentation digests better (enzyme clock outpaces gas clock)', () => {
    // 48 h at 4 °C spends about the same gas budget as ~7.4 h at 21 °C, but
    // banks far more maturation-clock time
    const cold = constProf(48, 4);
    const warm = constProf(cold.gasUnits, 21); // equal rise budget
    assert.ok(digestScore(cold.matureUnits, 'commercial', 'straight')
            > digestScore(warm.matureUnits, 'commercial', 'straight'),
      'cold wins per unit of rise');
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
  test('48 h cold digests like its maturation-clock equivalent, and beats a same-rise warm dough', () => {
    // wall-clock parity no longer favours cold (the linked digestibility study
    // tracks time at temperature), but at equal rise budget cold still wins
    const sameRiseWarm = computeAll({ ...inp, tempC: 21, ddt: 21, hours: Math.round(M.profile.gasUnits) });
    assert.ok(M.digest > sameRiseWarm.digest, 'cold banks more enzyme time per unit of rise');
  });
  test('cold single-stage schedule flags the missing warm-up', () => {
    assert.ok(M.verdicts.warmup, 'dough would hit the bench at fridge temp');
    assert.equal(M.verdicts.warmup.tone, 'warn');
  });
});

describe('computeAll — two-stage NY preset (fridge bulk + room-temp ball proof)', () => {
  const inp = {
    tempC: 4, hours: 46, split: true, temp2C: 21, hours2: 2,
    protein: 13, plVal: 50,
    hydration: 63, salt: 2, oilPct: 2.5, sugarPct: 1,
    leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
    ovenC: 300, surface: 'steel', ddt: 24,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  };
  const M = computeAll(inp);

  test('ferment verdict is good — the maturation clock, not the wall clock, spends capacity', () => {
    assert.equal(M.verdicts.ferment.tone, 'good');
    assert.ok(M.verdicts.ferment.params.m > 48, 'wall-clock capacity exceeds the schedule');
  });
  test('no over-proof panel for a standard 48 h NY schedule', () => {
    assert.equal(M.overProof, null);
  });
  test('proof quality is full', () => assert.equal(M.proof, 1));
  test('warm ball stage clears the warm-up flag', () => {
    assert.equal(M.verdicts.warmup, null);
  });
  test('dose sits in the professional 0.2–0.7% IDY window', () => {
    assert.ok(M.r.idyPct > 0.2 && M.r.idyPct < 0.7, `idyPct=${M.r.idyPct.toFixed(3)}`);
  });
  test('needs less yeast than pricing the whole 48 h at fridge temperature', () => {
    const allCold = computeAll({ ...inp, split: false, hours: 48 });
    assert.ok(M.r.idyPct < allCold.r.idyPct, 'the warm stage contributes budget');
  });
  test('rise curve exposes the bulk→ball boundary', () => {
    assert.deepEqual(M.rise.boundaries, [46]);
  });
  test('reversed hybrid (warm bulk, cold balls) also computes sanely', () => {
    const rev = computeAll({ ...inp, tempC: 21, hours: 7, temp2C: 4, hours2: 12 });
    assert.ok(rev.r.idyPct > 0 && Number.isFinite(rev.r.idyPct));
    assert.ok(rev.verdicts.warmup, 'ending cold still flags the warm-up');
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
  const m   = riseModel(constProf(8), 12);
  const pad = { l: 40, r: 20, t: 20, b: 30 };
  const P   = buildRisePaths(m, 400, 200, pad, 260);

  test('returns required keys: line, area, target, lagX, baselineY', () => {
    assert.ok('line' in P && 'area' in P && 'target' in P && 'lagX' in P && 'baselineY' in P);
  });

  test('single-stage schedule yields no boundary markers', () => {
    assert.deepEqual(P.boundaryXs, []);
  });

  test('two-stage schedule yields one boundary marker inside the plot', () => {
    const m2 = riseModel(fermentProfile([{ tempC: 4, hours: 46 }, { tempC: 21, hours: 2 }], 24), 13);
    const P2 = buildRisePaths(m2, 400, 200, pad, 260);
    assert.equal(P2.boundaryXs.length, 1);
    assert.ok(P2.boundaryXs[0] > pad.l && P2.boundaryXs[0] < 400 - pad.r);
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

  // ddt 21 = tempC 21 → no equilibration segment, so at 21 °C the maturation
  // clock equals the wall clock and the old threshold arithmetic holds exactly
  const baseInp = { ...BASE, protein: 12, tempC: 21, salt: 2.5, preferment: 'straight', hydration: 60 };
  const op = (inp, fp) => overProofRecommendations(inp, fp, profFor(inp));

  test('returns null when raw < 0.8 (hours well under capacity)', () => {
    assert.equal(op({ ...baseInp, hours: 10 }, fp12), null); // 10/24 ≈ 0.42
  });

  test('returns null at exactly 79% of capacity', () => {
    assert.equal(op({ ...baseInp, hours: 19 }, fp12), null); // 19/24 ≈ 0.79
  });

  test('caution severity at 80–99% of capacity', () => {
    const o = op({ ...baseInp, hours: 20 }, fp12); // 20/24 ≈ 0.83
    assert.equal(o.severity, 'caution');
    assert.equal(o.labelCode, 'overproof.caution');
  });

  test('warn severity at 100–124% of capacity', () => {
    const o = op({ ...baseInp, hours: 26 }, fp12); // 26/24 ≈ 1.08
    assert.equal(o.severity, 'warn');
    assert.equal(o.labelCode, 'overproof.warn');
  });

  test('bad severity at ≥125% of capacity', () => {
    const o = op({ ...baseInp, hours: 32 }, fp12); // 32/24 ≈ 1.33
    assert.equal(o.severity, 'bad');
    assert.equal(o.labelCode, 'overproof.bad');
  });

  test('raw field equals maturation units / maxHours (= hours/maxHours at 21 °C)', () => {
    const o = op({ ...baseInp, hours: 20 }, fp12);
    near(o.raw, 20 / 24, 0.001, 'raw = matureUnits / maxHours');
  });

  test('why text mentions headroom when below capacity', () => {
    const o = op({ ...baseInp, hours: 20 }, fp12);
    assert.equal(o.whyCode, 'overproof.why.near');
    assert.ok(o.whyParams.headroom > 0, JSON.stringify(o.whyParams));
  });

  test('why text mentions collapsing when at/over capacity', () => {
    const o = op({ ...baseInp, hours: 26 }, fp12);
    assert.equal(o.whyCode, 'overproof.why.over');
  });

  test('moving the same wall-clock hours into the fridge dissolves the warning', () => {
    // 26 h at 21 °C is over capacity; 26 h at 8 °C spends only ~13 maturation
    // hours, so the panel disappears entirely
    assert.notEqual(op({ ...baseInp, hours: 26 }, fp12), null);
    assert.equal(op({ ...baseInp, hours: 26, tempC: 8, ddt: 8 }, fp12), null);
  });

  // ── lever conditions ──

  test('protein lever appears when protein < 13', () => {
    const o = op({ ...baseInp, hours: 26, protein: 12 }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.proteinKey'));
  });

  test('protein lever absent when protein >= 13', () => {
    const fp13 = flourProfile(13, 0);
    const o    = op({ ...baseInp, hours: 40, protein: 13 }, fp13);
    assert.ok(!o.levers.some(l => l.kCode === 'overproof.lever.proteinKey'));
  });

  test('temperature lever appears when the schedule mean temp > 10', () => {
    const o = op({ ...baseInp, hours: 26, tempC: 20 }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.temperatureKey'));
  });

  test('temperature lever absent when the schedule mean temp <= 10', () => {
    // long enough in the cold that the panel still shows, but the dough is
    // already cold — no point advising a colder ferment
    const o = op({ ...baseInp, hours: 45, tempC: 8, ddt: 8 }, fp12);
    assert.notEqual(o, null);
    assert.ok(!o.levers.some(l => l.kCode === 'overproof.lever.temperatureKey'));
  });

  test('salt lever appears when salt < 2.5', () => {
    const o = op({ ...baseInp, hours: 26, salt: 2.0 }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.saltKey'));
  });

  test('salt lever absent when salt >= 2.5', () => {
    const o = op({ ...baseInp, hours: 26, salt: 2.5 }, fp12);
    assert.ok(!o.levers.some(l => l.kCode === 'overproof.lever.saltKey'));
  });

  test('time lever is always present', () => {
    const o = op({ ...baseInp, hours: 26 }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.timeKey'));
  });

  test('preferment lever appears for straight dough', () => {
    const o = op({ ...baseInp, hours: 26, preferment: 'straight' }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
  });

  test('preferment lever absent for biga or poolish', () => {
    const oBiga    = op({ ...baseInp, hours: 26, preferment: 'biga' },    fp12);
    const oPoolish = op({ ...baseInp, hours: 26, preferment: 'poolish' }, fp12);
    assert.ok(!oBiga.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
    assert.ok(!oPoolish.levers.some(l => l.kCode === 'overproof.lever.prefermentKey'));
  });

  test('hydration lever appears when hydration > 68', () => {
    const o = op({ ...baseInp, hours: 26, hydration: 70 }, fp12);
    assert.ok(o.levers.some(l => l.kCode === 'overproof.lever.hydrationKey'));
  });

  test('hydration lever absent when hydration <= 68', () => {
    const o = op({ ...baseInp, hours: 26, hydration: 65 }, fp12);
    assert.ok(!o.levers.some(l => l.kCode === 'overproof.lever.hydrationKey'));
  });
});
