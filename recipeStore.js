// The recipe box — everything the app remembers about *you*, kept in the
// browser and nowhere else. Three kinds of thing live here:
//
//   recipes  doughs you saved, whether you built them or a share link
//            brought them in
//   flours   bags in your cupboard: a name plus the protein / P-L numbers,
//            so those two sliders stop being guesswork (the built-in
//            catalogue is FLOUR_PRESETS in doughEngine.js)
//   kitchen  your oven, surface, room temperature, target dough temp and
//            mixing method — properties of where you bake rather than of
//            any one recipe, so they can be applied on a cold start
//
// It all goes in a single localStorage key under one versioned envelope,
// which makes "export everything I own" a one-liner and migrations a single
// switch on `version` later.
//
// A dough is only ever admitted through the engine's sanitizeInputs, which
// is the one definition of a legal dough, so a hand-edited storage blob, a
// stale export or a foreign file is checked as strictly as anything else.
//
// Loaded two ways, same as doughEngine.js and shareLink.js:
//   - Node (tests):   require('./recipeStore.js') — pass your own storage
//                     object to createStore(), no browser needed
//   - Browser (app):  <script src="recipeStore.js"> after doughEngine.js,
//                     then window.RecipeStore.createStore()

(function () {
'use strict';

const engine = (typeof module !== 'undefined' && module.exports)
  ? require('./doughEngine.js')
  : window.DoughEngine;
const { sanitizeInputs, DOUGH_RANGES, DOUGH_ENUMS } = engine;
const ENUM_FIELDS = Object.keys(DOUGH_ENUMS);

// Names are typed by the user or arrive inside someone's share link, and
// end up in the DOM, in this blob and in a filename. Control characters go,
// whitespace collapses, and a bidi override would let a stranger's link
// render its name as something else entirely, so those go too.
const NAME_MAX = 64;
function fitName(name) {
  return String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

const STORAGE_KEY = 'forno.box.v1';
const VERSION = 1;
const MAX_RECIPES = 100;
const MAX_FLOURS = 50;

// Which of the dough's fields describe the kitchen rather than the recipe.
// Everything else in `inputs` is the dough itself.
const KITCHEN_FIELDS = ['ovenC', 'surface', 'roomTemp', 'ddt', 'mixMethod'];

// Fixed field order, so two objects holding the same dough always produce
// the same identity string no matter how they were built.
const CANON_FIELDS = Object.keys(DOUGH_RANGES).sort().concat(ENUM_FIELDS.slice().sort());

function canonicalKey(inputs) {
  const clean = sanitizeInputs(inputs);
  if (!clean) return null;
  return CANON_FIELDS.map((k) => k + ':' + clean[k]).join('|');
}

function emptyBox() {
  return { version: VERSION, recipes: [], flours: [], kitchen: null, defaultRecipeId: null };
}

// ---- validation ------------------------------------------------------
// Anything read back from storage or an import file is treated as hostile
// until it's been through here: drop what doesn't fit rather than letting
// one bad row take the whole box down.

function validRecipe(row, newId, now) {
  if (!row || typeof row !== 'object') return null;
  const inputs = sanitizeInputs(row.inputs);
  if (!inputs) return null;
  const name = fitName(row.name);
  if (!name) return null;
  const created = Number(row.createdAt);
  const updated = Number(row.updatedAt);
  return {
    id: typeof row.id === 'string' && row.id ? row.id : newId(),
    name,
    inputs,
    source: row.source === 'shared' ? 'shared' : 'mine',
    createdAt: Number.isFinite(created) ? created : now(),
    updatedAt: Number.isFinite(updated) ? updated : now(),
  };
}

function validFlour(row, newId, now) {
  if (!row || typeof row !== 'object') return null;
  const name = fitName(row.name);
  const protein = Number(row.protein);
  const plVal = Number(row.plVal);
  const [pLo, pHi] = DOUGH_RANGES.protein;
  const [lLo, lHi] = DOUGH_RANGES.plVal;
  if (!name) return null;
  if (!Number.isFinite(protein) || protein < pLo || protein > pHi) return null;
  if (!Number.isFinite(plVal) || plVal < lLo || plVal > lHi) return null;
  const created = Number(row.createdAt);
  return {
    id: typeof row.id === 'string' && row.id ? row.id : newId(),
    name,
    protein: Math.round(protein * 10) / 10,
    plVal: Math.round(plVal),
    createdAt: Number.isFinite(created) ? created : now(),
  };
}

// A kitchen is a partial dough: the five fields above, validated against
// the same ranges by filling the rest from a known-good dough.
function validKitchen(row, now) {
  if (!row || typeof row !== 'object') return null;
  const probe = {};
  for (const [key, [lo]] of Object.entries(DOUGH_RANGES)) probe[key] = lo;
  for (const key of ENUM_FIELDS) probe[key] = DOUGH_ENUMS[key][0];
  for (const key of KITCHEN_FIELDS) probe[key] = row[key];
  const clean = sanitizeInputs(probe);
  if (!clean) return null;
  const out = { updatedAt: Number(row.updatedAt) || now() };
  for (const key of KITCHEN_FIELDS) out[key] = clean[key];
  return out;
}

// ---- storage ---------------------------------------------------------

function memoryStorage() {
  let value = null;
  return {
    getItem() { return value; },
    setItem(k, v) { value = String(v); },
    removeItem() { value = null; },
  };
}

function usable(storage) {
  try {
    const probe = STORAGE_KEY + '.probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch (e) {
    return false; // Safari private mode, disabled cookies, sandboxed iframe
  }
}

function isQuotaError(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22 || err.code === 1014;
}

function defaultNewId() {
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (c && c.randomUUID) return c.randomUUID();
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// storage: anything with getItem/setItem/removeItem. Defaults to
// localStorage in a browser; falls back to an in-memory shim when storage
// is unavailable, so the box still works for the session — `persistent`
// tells the UI whether to warn that it won't outlive the tab.
function createStore(storage, opts) {
  const options = opts || {};
  const now = options.now || (() => Date.now());
  const newId = options.newId || defaultNewId;
  let target = storage
    || (typeof window !== 'undefined' && window.localStorage)
    || memoryStorage();
  let persistent = usable(target);
  if (!persistent) target = memoryStorage();

  function read() {
    let raw = null;
    try { raw = target.getItem(STORAGE_KEY); } catch (e) { return emptyBox(); }
    if (!raw) return emptyBox();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return emptyBox(); }
    return adopt(parsed);
  }

  // Turn anything JSON-shaped into a box we're willing to work with. Used
  // for both storage reads and imported files — same trust level, same
  // treatment.
  function adopt(parsed) {
    const box = emptyBox();
    if (!parsed || typeof parsed !== 'object') return box;
    const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
    const flours = Array.isArray(parsed.flours) ? parsed.flours : [];
    const seen = new Set();
    for (const row of recipes) {
      const rec = validRecipe(row, newId, now);
      if (!rec || seen.has(rec.id)) continue;
      seen.add(rec.id);
      box.recipes.push(rec);
      if (box.recipes.length >= MAX_RECIPES) break;
    }
    const seenFlour = new Set();
    for (const row of flours) {
      const flour = validFlour(row, newId, now);
      if (!flour || seenFlour.has(flour.id)) continue;
      seenFlour.add(flour.id);
      box.flours.push(flour);
      if (box.flours.length >= MAX_FLOURS) break;
    }
    box.kitchen = validKitchen(parsed.kitchen, now);
    box.defaultRecipeId = box.recipes.some((r) => r.id === parsed.defaultRecipeId)
      ? parsed.defaultRecipeId : null;
    return box;
  }

  // Every mutation goes through here, so a full disk or a private window is
  // reported the same way everywhere instead of throwing from a click
  // handler. On failure the box is left as it was on disk.
  function write(box) {
    try {
      target.setItem(STORAGE_KEY, JSON.stringify(box));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: isQuotaError(err) ? 'quota' : 'unavailable' };
    }
  }

  function mutate(fn) {
    const box = read();
    const result = fn(box);
    if (result && result.ok === false) return result;
    const written = write(box);
    if (!written.ok) return written;
    return Object.assign({ ok: true }, result || {});
  }

  return {
    STORAGE_KEY,
    get persistent() { return persistent; },

    read,
    listRecipes() { return read().recipes; },
    getRecipe(id) { return read().recipes.find((r) => r.id === id) || null; },

    // Returns the existing recipe holding this exact dough, if there is
    // one — the UI uses it to say "you already have this" instead of
    // stacking up identical rows from a re-sent link.
    findByInputs(inputs) {
      const key = canonicalKey(inputs);
      if (!key) return null;
      return read().recipes.find((r) => canonicalKey(r.inputs) === key) || null;
    },

    // { ok, reason?, recipe? } — reason is 'invalid', 'duplicate', 'full',
    // 'quota' or 'unavailable'.
    saveRecipe({ name, inputs, source }) {
      const rec = validRecipe({ name, inputs, source, createdAt: now(), updatedAt: now() }, newId, now);
      if (!rec) return { ok: false, reason: 'invalid' };
      const key = canonicalKey(rec.inputs);
      return mutate((box) => {
        const dup = box.recipes.find((r) => canonicalKey(r.inputs) === key);
        if (dup) return { ok: false, reason: 'duplicate', recipe: dup };
        if (box.recipes.length >= MAX_RECIPES) return { ok: false, reason: 'full' };
        box.recipes.unshift(rec);
        return { recipe: rec };
      });
    },

    renameRecipe(id, name) {
      const clean = fitName(name);
      if (!clean) return { ok: false, reason: 'invalid' };
      return mutate((box) => {
        const rec = box.recipes.find((r) => r.id === id);
        if (!rec) return { ok: false, reason: 'missing' };
        rec.name = clean;
        rec.updatedAt = now();
        return { recipe: rec };
      });
    },

    // Save-over: point an existing recipe at the dough currently on screen.
    updateRecipeInputs(id, inputs) {
      const clean = sanitizeInputs(inputs);
      if (!clean) return { ok: false, reason: 'invalid' };
      return mutate((box) => {
        const rec = box.recipes.find((r) => r.id === id);
        if (!rec) return { ok: false, reason: 'missing' };
        rec.inputs = clean;
        rec.updatedAt = now();
        return { recipe: rec };
      });
    },

    deleteRecipe(id) {
      return mutate((box) => {
        const before = box.recipes.length;
        box.recipes = box.recipes.filter((r) => r.id !== id);
        if (box.recipes.length === before) return { ok: false, reason: 'missing' };
        if (box.defaultRecipeId === id) box.defaultRecipeId = null;
        return {};
      });
    },

    listFlours() { return read().flours; },

    saveFlour({ name, protein, plVal }) {
      const flour = validFlour({ name, protein, plVal, createdAt: now() }, newId, now);
      if (!flour) return { ok: false, reason: 'invalid' };
      return mutate((box) => {
        // Same name = the same bag, re-measured. Update it rather than
        // growing a shelf full of near-duplicates.
        const existing = box.flours.find((f) => f.name.toLowerCase() === flour.name.toLowerCase());
        if (existing) {
          existing.protein = flour.protein;
          existing.plVal = flour.plVal;
          return { flour: existing, replaced: true };
        }
        if (box.flours.length >= MAX_FLOURS) return { ok: false, reason: 'full' };
        box.flours.push(flour);
        return { flour };
      });
    },

    deleteFlour(id) {
      return mutate((box) => {
        const before = box.flours.length;
        box.flours = box.flours.filter((f) => f.id !== id);
        if (box.flours.length === before) return { ok: false, reason: 'missing' };
        return {};
      });
    },

    getKitchen() { return read().kitchen; },

    // Takes a whole dough and keeps only the kitchen's share of it.
    saveKitchen(inputs) {
      const kitchen = validKitchen(inputs, now);
      if (!kitchen) return { ok: false, reason: 'invalid' };
      return mutate((box) => { box.kitchen = kitchen; return { kitchen }; });
    },

    clearKitchen() {
      return mutate((box) => { box.kitchen = null; return {}; });
    },

    getDefaultRecipeId() { return read().defaultRecipeId; },

    setDefaultRecipe(id) {
      return mutate((box) => {
        if (id != null && !box.recipes.some((r) => r.id === id)) return { ok: false, reason: 'missing' };
        box.defaultRecipeId = id == null ? null : id;
        return {};
      });
    },

    // localStorage is the only copy of any of this, and clearing site data
    // is one menu click, so the box has to be able to leave the browser.
    exportJSON() {
      const box = read();
      return JSON.stringify({ app: 'forno', kind: 'recipe-box', exportedAt: now(), ...box }, null, 2);
    },

    // Merges by default: import adds what's new and skips doughs already on
    // the shelf, so re-importing a backup is harmless. { replace: true }
    // swaps the box wholesale instead.
    importJSON(json, importOpts) {
      const replace = !!(importOpts && importOpts.replace);
      let parsed;
      try { parsed = JSON.parse(String(json)); } catch (e) { return { ok: false, reason: 'unreadable' }; }
      const incoming = adopt(parsed);
      if (!incoming.recipes.length && !incoming.flours.length && !incoming.kitchen) {
        return { ok: false, reason: 'empty' };
      }
      if (replace) {
        const written = write(incoming);
        if (!written.ok) return written;
        return { ok: true, added: incoming.recipes.length, skipped: 0, flours: incoming.flours.length };
      }
      let added = 0, skipped = 0, floursAdded = 0;
      const result = mutate((box) => {
        const keys = new Set(box.recipes.map((r) => canonicalKey(r.inputs)));
        const ids = new Set(box.recipes.map((r) => r.id));
        for (const rec of incoming.recipes) {
          const key = canonicalKey(rec.inputs);
          if (keys.has(key)) { skipped++; continue; }
          if (box.recipes.length >= MAX_RECIPES) { skipped++; continue; }
          if (ids.has(rec.id)) rec.id = newId();
          keys.add(key);
          ids.add(rec.id);
          box.recipes.push(rec);
          added++;
        }
        const names = new Set(box.flours.map((f) => f.name.toLowerCase()));
        for (const flour of incoming.flours) {
          if (names.has(flour.name.toLowerCase())) continue;
          if (box.flours.length >= MAX_FLOURS) break;
          names.add(flour.name.toLowerCase());
          box.flours.push(flour);
          floursAdded++;
        }
        if (!box.kitchen && incoming.kitchen) box.kitchen = incoming.kitchen;
        return {};
      });
      if (!result.ok) return result;
      return { ok: true, added, skipped, flours: floursAdded };
    },

    // Wipes everything this app has stored. Used by the UI's "forget
    // everything" control; separate from deleting one recipe so it can't
    // happen by accident.
    clear() {
      try { target.removeItem(STORAGE_KEY); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'unavailable' }; }
    },
  };
}

const __STORE__ = {
  createStore, canonicalKey,
  STORAGE_KEY, VERSION, MAX_RECIPES, MAX_FLOURS, NAME_MAX, KITCHEN_FIELDS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __STORE__;
if (typeof window !== 'undefined') window.RecipeStore = __STORE__;

})();
