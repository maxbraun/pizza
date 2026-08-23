// Unit tests for the browser-storage recipe box.
// Run: node --test recipeStore.test.js
// No build step, no npm, no browser — createStore() takes any object with
// getItem/setItem/removeItem, so a plain fake stands in for localStorage.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStore, canonicalKey, STORAGE_KEY, MAX_RECIPES, MAX_FLOURS, KITCHEN_FIELDS } = require('./recipeStore.js');

const BASE = {
  tempC: 21, hours: 8, protein: 12.5, plVal: 50, hydration: 62,
  salt: 2.5, oilPct: 1.5, sugarPct: 0.5, starterStr: 50,
  ballCount: 4, ballWeight: 250, roomTemp: 20, ddt: 24, ovenC: 250,
  leavening: 'commercial', yeastType: 'idy', preferment: 'straight',
  mixMethod: 'hand', surface: 'steel',
};

// A localStorage stand-in. `failWith` makes the next writes throw the way a
// full disk or a private window does.
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    failWith: null,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (this.failWith) throw this.failWith; map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    raw() { return map.get(STORAGE_KEY); },
  };
}

let seq = 0;
function makeStore(storage) {
  seq = 0;
  return createStore(storage || fakeStorage(), { newId: () => 'id' + (++seq), now: () => 1000 });
}

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

describe('canonicalKey', () => {
  test('is stable regardless of key order', () => {
    const shuffled = Object.fromEntries(Object.entries(BASE).reverse());
    assert.equal(canonicalKey(shuffled), canonicalKey(BASE));
  });

  test('changes when any field changes', () => {
    assert.notEqual(canonicalKey({ ...BASE, hydration: 63 }), canonicalKey(BASE));
    assert.notEqual(canonicalKey({ ...BASE, surface: 'stone' }), canonicalKey(BASE));
  });

  test('is null for a dough that would never be admitted', () => {
    assert.equal(canonicalKey({ ...BASE, hydration: 999 }), null);
    assert.equal(canonicalKey(null), null);
  });
});

describe('saving and listing recipes', () => {
  test('a fresh box is empty', () => {
    const store = makeStore();
    assert.deepEqual(store.listRecipes(), []);
    assert.equal(store.getKitchen(), null);
    assert.deepEqual(store.listFlours(), []);
    assert.equal(store.getDefaultRecipeId(), null);
  });

  test('saves a dough and reads it back', () => {
    const store = makeStore();
    const res = store.saveRecipe({ name: 'Saturday', inputs: BASE });
    assert.equal(res.ok, true);
    assert.equal(res.recipe.name, 'Saturday');
    assert.equal(res.recipe.source, 'mine');
    assert.deepEqual(store.getRecipe(res.recipe.id).inputs, BASE);
    assert.equal(store.listRecipes().length, 1);
  });

  test('survives a round trip through the storage blob', () => {
    const storage = fakeStorage();
    makeStore(storage).saveRecipe({ name: 'Saturday', inputs: BASE });
    const reopened = createStore(storage);
    assert.equal(reopened.listRecipes()[0].name, 'Saturday');
    assert.deepEqual(reopened.listRecipes()[0].inputs, BASE);
  });

  test('newest first', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'first', inputs: BASE });
    store.saveRecipe({ name: 'second', inputs: { ...BASE, hydration: 65 } });
    assert.deepEqual(store.listRecipes().map((r) => r.name), ['second', 'first']);
  });

  test('marks a dough that arrived from someone else', () => {
    const store = makeStore();
    const res = store.saveRecipe({ name: 'From Marco', inputs: BASE, source: 'shared' });
    assert.equal(res.recipe.source, 'shared');
  });

  test('refuses the same dough twice and points at the one already saved', () => {
    const store = makeStore();
    const first = store.saveRecipe({ name: 'Saturday', inputs: BASE });
    const again = store.saveRecipe({ name: 'A different name', inputs: { ...BASE } });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(again.recipe.id, first.recipe.id);
    assert.equal(store.listRecipes().length, 1);
  });

  test('findByInputs locates a saved dough and ignores an unsaved one', () => {
    const store = makeStore();
    const saved = store.saveRecipe({ name: 'Saturday', inputs: BASE }).recipe;
    assert.equal(store.findByInputs({ ...BASE }).id, saved.id);
    assert.equal(store.findByInputs({ ...BASE, hydration: 70 }), null);
    assert.equal(store.findByInputs({ ...BASE, hydration: 999 }), null);
  });

  test('rejects a nameless or invalid dough', () => {
    const store = makeStore();
    assert.equal(store.saveRecipe({ name: '', inputs: BASE }).reason, 'invalid');
    assert.equal(store.saveRecipe({ name: '   ', inputs: BASE }).reason, 'invalid');
    assert.equal(store.saveRecipe({ name: 'ok', inputs: { ...BASE, hydration: 999 } }).reason, 'invalid');
    assert.equal(store.saveRecipe({ name: 'ok', inputs: null }).reason, 'invalid');
    assert.equal(store.listRecipes().length, 0);
  });

  test('stores the name in the form a share link can carry', () => {
    const store = makeStore();
    const res = store.saveRecipe({ name: '  Marco   dough  ', inputs: BASE });
    assert.equal(res.recipe.name, 'Marco dough');
  });

  test('stops at the recipe cap', () => {
    const store = makeStore();
    for (let i = 0; i < MAX_RECIPES; i++) {
      const inputs = { ...BASE, hours: 2 + (i % 90), hydration: 50 + Math.floor(i / 90) };
      const r = store.saveRecipe({ name: 'dough ' + i, inputs });
      assert.equal(r.ok, true, 'save ' + i);
    }
    const overflow = store.saveRecipe({ name: 'one too many', inputs: { ...BASE, hydration: 85 } });
    assert.equal(overflow.reason, 'full');
    assert.equal(store.listRecipes().length, MAX_RECIPES);
  });
});

describe('editing recipes', () => {
  test('renames', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'old', inputs: BASE }).recipe.id;
    assert.equal(store.renameRecipe(id, 'new').ok, true);
    assert.equal(store.getRecipe(id).name, 'new');
  });

  test('refuses an empty rename or an unknown id', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'old', inputs: BASE }).recipe.id;
    assert.equal(store.renameRecipe(id, '  ').reason, 'invalid');
    assert.equal(store.renameRecipe('nope', 'new').reason, 'missing');
    assert.equal(store.getRecipe(id).name, 'old');
  });

  test('saves over a recipe with the dough currently on screen', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'work in progress', inputs: BASE }).recipe.id;
    assert.equal(store.updateRecipeInputs(id, { ...BASE, hydration: 68 }).ok, true);
    assert.equal(store.getRecipe(id).inputs.hydration, 68);
    assert.equal(store.getRecipe(id).name, 'work in progress');
  });

  test('refuses to save over with an invalid dough', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'x', inputs: BASE }).recipe.id;
    assert.equal(store.updateRecipeInputs(id, { ...BASE, salt: 99 }).reason, 'invalid');
    assert.equal(store.getRecipe(id).inputs.salt, BASE.salt);
  });

  test('deletes', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'x', inputs: BASE }).recipe.id;
    assert.equal(store.deleteRecipe(id).ok, true);
    assert.equal(store.listRecipes().length, 0);
    assert.equal(store.deleteRecipe(id).reason, 'missing');
  });
});

describe('the default recipe', () => {
  test('is set and read back', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'house dough', inputs: BASE }).recipe.id;
    assert.equal(store.setDefaultRecipe(id).ok, true);
    assert.equal(store.getDefaultRecipeId(), id);
    assert.equal(store.setDefaultRecipe(null).ok, true);
    assert.equal(store.getDefaultRecipeId(), null);
  });

  test('cannot point at a recipe that does not exist', () => {
    const store = makeStore();
    assert.equal(store.setDefaultRecipe('nope').reason, 'missing');
  });

  test('is cleared when its recipe is deleted', () => {
    const store = makeStore();
    const id = store.saveRecipe({ name: 'house dough', inputs: BASE }).recipe.id;
    store.setDefaultRecipe(id);
    store.deleteRecipe(id);
    assert.equal(store.getDefaultRecipeId(), null);
  });
});

describe('the flour shelf', () => {
  test('saves a flour and reads it back', () => {
    const store = makeStore();
    const res = store.saveFlour({ name: 'Caputo Cuoco', protein: 13, plVal: 55 });
    assert.equal(res.ok, true);
    assert.deepEqual(store.listFlours().map((f) => f.name), ['Caputo Cuoco']);
    assert.equal(store.listFlours()[0].protein, 13);
  });

  test('re-saving the same name updates that bag instead of adding another', () => {
    const store = makeStore();
    store.saveFlour({ name: 'Caputo Cuoco', protein: 13, plVal: 55 });
    const res = store.saveFlour({ name: 'caputo cuoco', protein: 13.4, plVal: 60 });
    assert.equal(res.replaced, true);
    assert.equal(store.listFlours().length, 1);
    assert.equal(store.listFlours()[0].protein, 13.4);
    assert.equal(store.listFlours()[0].plVal, 60);
  });

  test('rejects a flour outside the slider ranges', () => {
    const store = makeStore();
    assert.equal(store.saveFlour({ name: 'unobtainium', protein: 40, plVal: 50 }).reason, 'invalid');
    assert.equal(store.saveFlour({ name: 'unobtainium', protein: 12, plVal: 500 }).reason, 'invalid');
    assert.equal(store.saveFlour({ name: '', protein: 12, plVal: 50 }).reason, 'invalid');
    assert.equal(store.listFlours().length, 0);
  });

  test('rounds to what the sliders can actually hold', () => {
    const store = makeStore();
    store.saveFlour({ name: 'odd bag', protein: 12.34567, plVal: 55.6 });
    assert.deepEqual(
      { protein: store.listFlours()[0].protein, plVal: store.listFlours()[0].plVal },
      { protein: 12.3, plVal: 56 },
    );
  });

  test('deletes, and stops at the shelf cap', () => {
    const store = makeStore();
    for (let i = 0; i < MAX_FLOURS; i++) store.saveFlour({ name: 'flour ' + i, protein: 12, plVal: 50 });
    assert.equal(store.saveFlour({ name: 'one too many', protein: 12, plVal: 50 }).reason, 'full');
    const id = store.listFlours()[0].id;
    assert.equal(store.deleteFlour(id).ok, true);
    assert.equal(store.listFlours().length, MAX_FLOURS - 1);
    assert.equal(store.deleteFlour(id).reason, 'missing');
  });
});

describe('the kitchen profile', () => {
  test('keeps only the kitchen fields out of a whole dough', () => {
    const store = makeStore();
    assert.equal(store.saveKitchen({ ...BASE, ovenC: 300, surface: 'stone' }).ok, true);
    const kitchen = store.getKitchen();
    assert.deepEqual(Object.keys(kitchen).sort(), KITCHEN_FIELDS.concat('updatedAt').sort());
    assert.equal(kitchen.ovenC, 300);
    assert.equal(kitchen.surface, 'stone');
    assert.equal(kitchen.hydration, undefined);
  });

  test('rejects a kitchen with an impossible oven or surface', () => {
    const store = makeStore();
    assert.equal(store.saveKitchen({ ...BASE, ovenC: 9000 }).reason, 'invalid');
    assert.equal(store.saveKitchen({ ...BASE, surface: 'lava' }).reason, 'invalid');
    assert.equal(store.saveKitchen(null).reason, 'invalid');
    assert.equal(store.getKitchen(), null);
  });

  test('clears', () => {
    const store = makeStore();
    store.saveKitchen(BASE);
    assert.equal(store.clearKitchen().ok, true);
    assert.equal(store.getKitchen(), null);
  });
});

describe('export and import', () => {
  test('exports everything and imports it into an empty box', () => {
    const source = makeStore();
    source.saveRecipe({ name: 'Saturday', inputs: BASE });
    source.saveRecipe({ name: 'Sunday', inputs: { ...BASE, hydration: 70 } });
    source.saveFlour({ name: 'Caputo Cuoco', protein: 13, plVal: 55 });
    source.saveKitchen({ ...BASE, ovenC: 300 });

    const target = makeStore();
    const res = target.importJSON(source.exportJSON());
    assert.equal(res.ok, true);
    assert.equal(res.added, 2);
    assert.equal(res.flours, 1);
    assert.deepEqual(target.listRecipes().map((r) => r.name).sort(), ['Saturday', 'Sunday']);
    assert.equal(target.getKitchen().ovenC, 300);
  });

  test('re-importing the same backup adds nothing', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'Saturday', inputs: BASE });
    const backup = store.exportJSON();
    const res = store.importJSON(backup);
    assert.equal(res.added, 0);
    assert.equal(res.skipped, 1);
    assert.equal(store.listRecipes().length, 1);
  });

  test('merges without touching what is already there', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'mine', inputs: BASE });
    const other = makeStore();
    other.saveRecipe({ name: 'theirs', inputs: { ...BASE, hydration: 75 } });
    const res = store.importJSON(other.exportJSON());
    assert.equal(res.added, 1);
    assert.deepEqual(store.listRecipes().map((r) => r.name).sort(), ['mine', 'theirs']);
  });

  test('gives an imported recipe a new id when it collides with one already held', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'mine', inputs: BASE });
    const clash = JSON.stringify({
      version: 1,
      recipes: [{ id: store.listRecipes()[0].id, name: 'theirs', inputs: { ...BASE, hydration: 75 } }],
    });
    assert.equal(store.importJSON(clash).added, 1);
    const ids = store.listRecipes().map((r) => r.id);
    assert.equal(new Set(ids).size, 2);
  });

  test('replace mode swaps the whole box', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'mine', inputs: BASE });
    const other = makeStore();
    other.saveRecipe({ name: 'theirs', inputs: { ...BASE, hydration: 75 } });
    assert.equal(store.importJSON(other.exportJSON(), { replace: true }).ok, true);
    assert.deepEqual(store.listRecipes().map((r) => r.name), ['theirs']);
  });

  test('drops rows that are not doughs, keeps the rest', () => {
    const store = makeStore();
    const mixed = JSON.stringify({
      version: 1,
      recipes: [
        { name: 'good', inputs: BASE },
        { name: 'no inputs' },
        { name: '', inputs: { ...BASE, hydration: 70 } },
        { name: 'out of range', inputs: { ...BASE, ovenC: 9000 } },
        'not even an object',
      ],
      flours: [{ name: 'fine', protein: 12, plVal: 50 }, { name: 'bad', protein: -3, plVal: 50 }],
    });
    const res = store.importJSON(mixed);
    assert.equal(res.added, 1);
    assert.deepEqual(store.listRecipes().map((r) => r.name), ['good']);
    assert.deepEqual(store.listFlours().map((f) => f.name), ['fine']);
  });

  test('reports unreadable and empty files instead of throwing', () => {
    const store = makeStore();
    assert.equal(store.importJSON('{not json').reason, 'unreadable');
    assert.equal(store.importJSON('').reason, 'unreadable');
    assert.equal(store.importJSON('{}').reason, 'empty');
    assert.equal(store.importJSON('[]').reason, 'empty');
    assert.equal(store.importJSON('"a string"').reason, 'empty');
  });

  test('an export declares what it is, so a stray file is recognisable', () => {
    const store = makeStore();
    store.saveRecipe({ name: 'Saturday', inputs: BASE });
    const parsed = JSON.parse(store.exportJSON());
    assert.equal(parsed.app, 'forno');
    assert.equal(parsed.kind, 'recipe-box');
    assert.equal(parsed.version, 1);
  });
});

describe('hostile and broken storage', () => {
  test('a corrupt blob reads as an empty box rather than throwing', () => {
    const store = createStore(fakeStorage({ [STORAGE_KEY]: 'not json at all' }));
    assert.deepEqual(store.listRecipes(), []);
    assert.equal(store.saveRecipe({ name: 'fresh start', inputs: BASE }).ok, true);
  });

  test('a hand-edited blob has its junk dropped and its good rows kept', () => {
    const blob = JSON.stringify({
      version: 1,
      recipes: [
        { id: 'a', name: 'real', inputs: BASE },
        { id: 'b', name: 'fake', inputs: { hydration: 'lots' } },
      ],
      flours: 'not an array',
      kitchen: { ovenC: 'hot' },
      defaultRecipeId: 'b',
    });
    const store = createStore(fakeStorage({ [STORAGE_KEY]: blob }));
    assert.deepEqual(store.listRecipes().map((r) => r.name), ['real']);
    assert.deepEqual(store.listFlours(), []);
    assert.equal(store.getKitchen(), null);
    assert.equal(store.getDefaultRecipeId(), null); // pointed at a row that was dropped
  });

  test('a full disk is reported, and the stored box is left as it was', () => {
    const storage = fakeStorage();
    const store = makeStore(storage);
    store.saveRecipe({ name: 'safe', inputs: BASE });
    storage.failWith = quotaError();
    const res = store.saveRecipe({ name: 'too big', inputs: { ...BASE, hydration: 80 } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'quota');
    storage.failWith = null;
    assert.deepEqual(store.listRecipes().map((r) => r.name), ['safe']);
  });

  test('a write failure that is not a quota error reads as unavailable', () => {
    const storage = fakeStorage();
    const store = makeStore(storage);
    storage.failWith = new Error('nope');
    assert.equal(store.saveRecipe({ name: 'x', inputs: BASE }).reason, 'unavailable');
  });

  test('storage that refuses everything still gives a working in-memory box', () => {
    const dead = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    const store = createStore(dead);
    assert.equal(store.persistent, false);
    assert.equal(store.saveRecipe({ name: 'this session only', inputs: BASE }).ok, true);
    assert.equal(store.listRecipes().length, 1);
  });

  test('working storage reports itself as persistent', () => {
    assert.equal(makeStore().persistent, true);
  });

  test('clear wipes the key entirely', () => {
    const storage = fakeStorage();
    const store = makeStore(storage);
    store.saveRecipe({ name: 'x', inputs: BASE });
    assert.equal(store.clear().ok, true);
    assert.equal(storage.raw(), undefined);
    assert.deepEqual(store.listRecipes(), []);
  });

  test('two stores over one storage see each other, as two tabs would', () => {
    const storage = fakeStorage();
    const tabA = createStore(storage);
    const tabB = createStore(storage);
    tabA.saveRecipe({ name: 'from tab A', inputs: BASE });
    assert.deepEqual(tabB.listRecipes().map((r) => r.name), ['from tab A']);
    tabB.saveRecipe({ name: 'from tab B', inputs: { ...BASE, hydration: 70 } });
    assert.equal(tabA.listRecipes().length, 2);
  });
});
