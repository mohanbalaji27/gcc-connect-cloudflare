import test from 'node:test';
import assert from 'node:assert/strict';

// The menu text helpers are plain TypeScript, so Node (22.18+) can load them directly.
const supportsTypeStripping = Number(process.versions.node.split('.')[0]) >= 23 || process.features.typescript;
const options = { skip: supportsTypeStripping ? false : 'needs Node 23+ to load .ts files' };
const text = () => import('../src/lib/menuText.ts');
const catalog = () => import('../src/lib/menuCatalog.ts');
const summary = (items) => items.map((item) => `${item.meal}/${item.course}/${item.name}/${item.diet}${item.special ? '/special' : ''}${item.note ? `/${item.note}` : ''}`);

test('menu text: headings, sections, diet marks in every style, notes and specials', options, async () => {
  const { parseMenuText } = await text();
  const { items, warnings } = parseMenuText(`
    Lunch
    Starters:
    • paneer tikka (v), Fish fry (nv)
    - Dal tadka v
    nv: Chicken curry, Mutton keema
    Breads & Rice:
    1. Jeera rice, ROTI, Naan (v) - with butter
    Desserts
    ★ Gulab jamun (vegan) - served hot
    Payasam (special)
  `);
  assert.deepEqual(summary(items), [
    'lunch/starters/Paneer tikka/veg', 'lunch/starters/Fish fry/non-veg', 'lunch/starters/Dal tadka/veg',
    'lunch/starters/Chicken curry/non-veg', 'lunch/starters/Mutton keema/non-veg',
    'lunch/breads-rice/Jeera rice/veg', 'lunch/breads-rice/Roti/veg', 'lunch/breads-rice/Naan/veg/with butter',
    'lunch/desserts/Gulab jamun/vegan/special/served hot', 'lunch/desserts/Payasam/veg/special',
  ]);
  assert.ok(warnings.some((warning) => warning.level === 'info' && /no veg \/ non-veg mark/.test(warning.message)));
  assert.equal(warnings.filter((warning) => warning.level === 'warn').length, 0);
});

test('menu text: heading styles, meal order, times and aliases', options, async () => {
  const { parseMenuText } = await text();
  const { items } = parseMenuText('== DINNER MENU ==\nDal (v)\n\nLunch (12:30 - 2:30 pm)\nRice (v)\n\nlunch: Curd (v)\n**Breakfast @ 8am**\nIdli (v)\nEvening Snacks:\nSamosa (v)\nTea time\nChai (vegan)');
  assert.deepEqual(summary(items), ['breakfast/mains/Idli/veg', 'lunch/mains/Rice/veg', 'lunch/mains/Curd/veg', 'snacks/mains/Samosa/veg', 'snacks/mains/Chai/vegan', 'dinner/mains/Dal/veg']);
});

test('menu text: dots, emoji, unicode bullets, fullwidth characters and messy spacing', options, async () => {
  const { parseMenuText } = await text();
  const { items } = parseMenuText('Lunch\r\n🟢 Rice 🟡 Boiled egg 🔴 Chicken 65\r\n   ▪   idli    ( V )  \r\n\u00a0\u00a0·\tVada [vegan]\r\n🍛 Biryani (nv)\r\nＭＩＸ，ｆｉｎｅ (v)\r\n');
  assert.deepEqual(summary(items), [
    'lunch/mains/Rice/veg', 'lunch/mains/Boiled egg/egg', 'lunch/mains/Chicken 65/non-veg', 'lunch/mains/Idli/veg', 'lunch/mains/Vada/vegan', 'lunch/mains/Biryani/non-veg', 'lunch/mains/MIX/veg', 'lunch/mains/Fine/veg',
  ]);
  assert.equal(items.find((item) => item.name === 'Biryani').emoji, '🍛');
});

test('menu text: commas inside brackets, escaped commas, notes and conflicting marks', options, async () => {
  const { parseMenuText } = await text();
  const { items, warnings } = parseMenuText('Lunch\nPaneer butter masala (rich, creamy) (v), Dal fry\\, jeera (v)\nKheer (v) (nv)\nCurd - v');
  assert.deepEqual(summary(items), ['lunch/mains/Paneer butter masala/veg/rich, creamy', 'lunch/mains/Dal fry, jeera/veg', 'lunch/mains/Kheer/veg', 'lunch/mains/Curd/veg']);
  assert.ok(warnings.some((warning) => /conflicting diet marks/.test(warning.message)));
});

test('menu text: missing meal heading, unknown sections, duplicates and empty sections are explained', options, async () => {
  const { parseMenuText } = await text();
  const result = parseMenuText('Idli (v)\nChaats:\nPani puri (v)\nDrinks:\nIdli (v)\nSoup\n', { defaultMeal: 'breakfast' });
  assert.deepEqual(summary(result.items), ['breakfast/mains/Idli/veg', 'breakfast/others/Pani puri/veg']);
  const messages = result.warnings.map((warning) => `${warning.line}:${warning.level}:${warning.message}`).join('\n');
  assert.match(messages, /1:info:No meal heading before this, so the dishes go under Breakfast/);
  assert.match(messages, /2:warn:Unknown section “Chaats”/);
  assert.match(messages, /5:warn:“Idli” is already in Breakfast \(line 1\)/);
  assert.match(messages, /“Drinks” has no dishes/);
});

test('menu text: names are inferred only when unmarked, and shouting is toned down', options, async () => {
  const { parseMenuText } = await text();
  const { items, warnings } = parseMenuText('Dinner\nCHICKEN CURRY\nSoya chicken-style chunks\nEgg curry\nBoiled egg (v)\nPANEER');
  assert.deepEqual(summary(items), ['dinner/mains/Chicken curry/non-veg', 'dinner/mains/Soya chicken-style chunks/veg', 'dinner/mains/Egg curry/egg', 'dinner/mains/Boiled egg/veg', 'dinner/mains/Paneer/veg']);
  assert.ok(warnings.some((warning) => /Chicken curry” was marked non-veg/.test(warning.message)));
});

test('menu text: limits, garbage and empty input never throw', options, async () => {
  const { parseMenuText } = await text();
  assert.deepEqual(parseMenuText('').items, []);
  assert.deepEqual(parseMenuText('\n  \n-----\n===\n// a comment').items, []);
  const long = parseMenuText(`Lunch\n${'x'.repeat(200)} (v)`);
  assert.equal(long.items[0].name.length, 80);
  assert.ok(long.warnings.some((warning) => /cut to 80/.test(warning.message)));
  const many = parseMenuText(`Lunch\n${Array.from({ length: 400 }, (_, index) => `Dish ${index}`).join('\n')}`);
  assert.equal(many.items.length, 300);
  assert.ok(many.warnings.some((warning) => /up to 300 dishes/.test(warning.message)));
  assert.doesNotThrow(() => parseMenuText('((((\n)))\n[[[]\n:::\n,,,\n(v)\n★\n🟢'));
});

test('menu text: formatting round-trips, ids are re-attached, and the signature follows the order inside a section only', options, async () => {
  const { parseMenuText, formatMenuText, reconcileIds, menuSignature, sortMenuItems } = await text();
  const original = parseMenuText('Breakfast\nIdli (v), Vada (v)\nLunch\nStarters:\nTikka (nv) - spicy\nMains:\nDal (v) ★\nPaneer (v) (jeera rice, roti, salad)\nDrinks:\n🍹 Lassi (v)\nDinner\nDal fry\\, jeera (v)').items;
  assert.equal(original.find((item) => item.name === 'Paneer').note, 'jeera rice, roti, salad');
  const again = parseMenuText(formatMenuText(original)).items;
  assert.deepEqual(summary(again), summary(original));
  assert.equal(again.find((item) => item.name === 'Lassi').emoji, '🍹');
  const withIds = reconcileIds(again, [{ id: 'a', meal: 'breakfast', name: 'IDLI' }, { id: 'b', meal: 'lunch', name: 'Dal' }, { id: 'c', meal: 'dinner', name: 'Idli' }]);
  assert.equal(withIds.find((item) => item.name === 'Idli').id, 'a');
  assert.equal(withIds.find((item) => item.name === 'Dal').id, 'b');
  assert.equal(withIds.find((item) => item.name === 'Vada').id, undefined);
  assert.equal(menuSignature(sortMenuItems([original.at(-1), ...original.slice(0, -1)])), menuSignature(original));
  assert.notEqual(menuSignature([...original].reverse()), menuSignature(original));
});

test('menu catalogue: the browser and the server agree on meals, sections and diets', options, async () => {
  const browser = await catalog();
  const server = await import('../server/menu-catalog.js');
  assert.deepEqual([...browser.MEAL_IDS], server.MEALS);
  assert.deepEqual([...browser.COURSE_IDS], server.COURSES);
  assert.deepEqual([...browser.DIET_IDS], server.DIETS);
  assert.deepEqual(browser.REVIEW_VISIBILITY_IDS, server.REVIEW_VISIBILITY);
  assert.equal(browser.MAX_DAY_ITEMS, server.MAX_DAY_ITEMS);
  assert.equal(browser.NAME_MAX, server.NAME_MAX);
  assert.equal(browser.NOTE_MAX, server.NOTE_MAX);
  assert.equal(browser.COMMENT_MAX, server.COMMENT_MAX);
  assert.equal(browser.currentMeal(9), 'breakfast');
  assert.equal(browser.currentMeal(13, 15), 'lunch');
  assert.equal(browser.currentMeal(16), 'snacks');
  assert.equal(browser.currentMeal(21), 'dinner');
});
