#!/usr/bin/env node
// Generates fixtures.json — the cross-language contract for doughEngine.
// Run: node gen-fixtures.js

const fs = require('fs');
const { computeAll } = require('./doughEngine.js');

const BASE = {
  tempC: 21, hours: 8, protein: 12, plVal: 50,
  hydration: 60, salt: 2.5, oilPct: 0, sugarPct: 0,
  leavening: 'commercial', yeastType: 'idy', starterStr: 50,
  preferment: 'straight', roomTemp: 20, ddt: 24,
  mixMethod: 'hand', doughWeight: 1000,
  ovenC: 250, surface: 'steel',
};

const CASES = [
  { name: 'base', inp: BASE },
  { name: 'neapolitan', inp: {
    tempC: 18, hours: 24, protein: 13, plVal: 55,
    hydration: 60, salt: 2.8, oilPct: 0, sugarPct: 0,
    leavening: 'commercial', yeastType: 'idy', preferment: 'biga',
    ovenC: 460, surface: 'stone', ddt: 23,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  }},
  { name: 'ny', inp: {
    tempC: 4, hours: 48, protein: 13, plVal: 50,
    hydration: 63, salt: 2, oilPct: 2.5, sugarPct: 1,
    leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
    ovenC: 300, surface: 'steel', ddt: 24,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  }},
  { name: 'detroit', inp: {
    tempC: 20, hours: 6, protein: 13, plVal: 45,
    hydration: 70, salt: 2, oilPct: 1, sugarPct: 0,
    leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
    ovenC: 280, surface: 'pan', ddt: 25,
    roomTemp: 22, mixMethod: 'mixer', doughWeight: 1200, starterStr: 50,
  }},
  { name: 'roman', inp: {
    tempC: 4, hours: 48, protein: 12.5, plVal: 40,
    hydration: 80, salt: 2.2, oilPct: 2, sugarPct: 0,
    leavening: 'commercial', yeastType: 'idy', preferment: 'poolish',
    ovenC: 290, surface: 'steel', ddt: 23,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 50,
  }},
  { name: 'sourdough', inp: {
    tempC: 5, hours: 24, protein: 12.5, plVal: 50,
    hydration: 72, salt: 2.5, oilPct: 0, sugarPct: 0,
    leavening: 'sourdough', yeastType: 'idy', preferment: 'straight',
    ovenC: 270, surface: 'steel', ddt: 24,
    roomTemp: 20, mixMethod: 'hand', doughWeight: 1000, starterStr: 60,
  }},
  { name: 'over_prove', inp: { ...BASE, protein: 10, hours: 48 } },
  { name: 'ady_yeast', inp: { ...BASE, yeastType: 'ady' } },
  { name: 'fresh_yeast', inp: { ...BASE, yeastType: 'fresh' } },
  { name: 'processor_mix', inp: { ...BASE, mixMethod: 'processor', ddt: 26 } },
];

function snapshot(m) {
  return {
    r: {
      flour:       m.r.flour,
      waterG:      m.r.waterG,
      saltGrams:   m.r.saltGrams,
      oilGrams:    m.r.oilGrams,
      sugarGrams:  m.r.sugarGrams,
      idyPct:      m.r.idyPct,
      pct:         m.r.pct,
      grams:       m.r.grams,
      tsp:         m.r.tsp,
      levainPct:   m.r.levainPct,
      levainGrams: m.r.levainGrams,
    },
    fp: {
      W:        m.fp.W,
      hydrLo:   m.fp.hydrLo,
      hydrHi:   m.fp.hydrHi,
      maxHours: m.fp.maxHours,
      category: m.fp.category,
    },
    rise: {
      Arise:    m.rise.Arise,
      lambda:   m.rise.lambda,
      maxHours: m.rise.maxHours,
      kd:       m.rise.kd,
      mu:       m.rise.mu,
    },
    proof:  m.proof,
    bake: {
      t:       m.bake.t,
      colour:  m.bake.colour,
      base:    m.bake.base,
      leopard: m.bake.leopard,
      acryl:   m.bake.acryl,
      style:   m.bake.style,
    },
    digest: m.digest,
    water:  { temp: m.water.temp },
    batch:  { balls: m.batch.balls, ballW: m.batch.ballW },
    geometry: {
      openness:   m.geometry.openness,
      strength:   m.geometry.strength,
      springFrac: m.geometry.springFrac,
      rimIndex:   m.geometry.rimIndex,
    },
    verdicts: {
      hydration: m.verdicts.hydration.tone,
      ferment:   m.verdicts.ferment.tone,
      digestion: m.verdicts.digestion.tone,
      bake:      m.verdicts.bake.tone,
    },
  };
}

const fixtures = CASES.map(({ name, inp }) => ({
  name,
  input: inp,
  output: snapshot(computeAll(inp)),
}));

fs.writeFileSync('fixtures.json', JSON.stringify(fixtures, null, 2));
console.log(`wrote ${fixtures.length} fixtures → fixtures.json`);
