// Forgiving parser for the quick "type or paste the whole day" menu editor. Pure functions, no imports from the browser,
// so they run in the tests too. The same text syntax is produced by formatMenuText, which keeps the text box and the grid in sync.
//
//   Lunch                         a meal heading (also "== Lunch ==", "Lunch:", "Lunch menu", "Lunch (12:30-2pm)")
//   Starters:                     a section heading; then one dish per line, or several separated by commas
//   Paneer tikka (v), Fish fry (nv)
//   - Dal tadka v                 bullets (- * • · 1.) are optional; diet marks: (v) (nv) (egg) (vegan), a trailing v / nv,
//   nv: Chicken curry             a "v:" / "nv:" / "egg:" / "vegan:" prefix for the line, or the dots 🟢 🔴 🟡 🌱
//   Gulab jamun (v) - served hot  everything after " - " is a note; extra (brackets) become notes too
//   ★ Payasam (v)                 a star or (special) highlights it as today's special; a leading emoji is kept as the dish emoji
import { COURSE_IDS, COURSES, DIETS, MAX_DAY_ITEMS, MEAL_IDS, MEALS, NAME_MAX, NOTE_MAX, type CourseId, type DietId, type MealId } from './menuCatalog.ts';

export interface DraftDish { id?: string; meal: MealId; course: CourseId; name: string; diet: DietId; note: string; special: boolean; emoji: string }
export interface ParsedDish extends DraftDish { line: number; dietMarked: boolean }
export interface ParseWarning { line: number; level: 'warn' | 'info'; message: string }
export interface ParseResult { items: ParsedDish[]; warnings: ParseWarning[] }

const canon = (value: string) => value.toLowerCase().replace(/\s*(&|\band\b|\+)\s*/g, ' & ').replace(/\s+/g, ' ').trim();
const aliasMap = <T extends string>(table: Record<T, { words: string[]; label: string }>) => {
  const map = new Map<string, T>();
  for (const [id, entry] of Object.entries(table) as [T, { words: string[]; label: string }][]) {
    for (const word of [...entry.words, entry.label, id.replace('-', ' ')]) map.set(canon(word), id);
  }
  return map;
};
const MEAL_ALIASES = aliasMap<MealId>(MEALS);
const COURSE_ALIASES = aliasMap<CourseId>(COURSES);

const DIET_WORDS: Record<string, DietId> = {
  v: 'veg', veg: 'veg', vegetarian: 'veg', nv: 'non-veg', nonveg: 'non-veg', nonvegetarian: 'non-veg', nveg: 'non-veg',
  egg: 'egg', eggs: 'egg', vegan: 'vegan', plantbased: 'vegan',
};
const dietOf = (word: string): DietId | undefined => DIET_WORDS[word.toLowerCase().replace(/[\s-]+/g, '')];
const DIET_EMOJI: Record<string, DietId> = { '🟢': 'veg', '🟩': 'veg', '🔴': 'non-veg', '🟥': 'non-veg', '🟡': 'egg', '🟨': 'egg', '🟠': 'egg', '🥚': 'egg', '🌱': 'vegan' };
const DIET_EMOJI_ALT = Object.keys(DIET_EMOJI).join('|');
const DIET_EMOJI_RE = new RegExp(`(?:${DIET_EMOJI_ALT})\\uFE0F?`, 'gu');
const DIET_EMOJI_START = new RegExp(`^(?:${DIET_EMOJI_ALT})`, 'u');
const DIET_EMOJI_SPLIT = new RegExp(`\\s+(?=(?:${DIET_EMOJI_ALT}))`, 'gu');
const DIET_WORD_RE = '(?:non[- ]?vegetarian|non[- ]?veg|vegetarian|plant-based|nveg|vegan|veg|eggs?|nv|v)';
const BULLET = /^(?:[-–—•·●▪■◦▸►➤*+>○◆◇✓✔→]\s+|\d{1,3}[.)]\s+)/u;
const SPECIAL_TEST = /[★⭐🌟✨☆]/u;
const SPECIAL_MARKS = /[★⭐🌟✨☆]/gu;
const SPECIAL_WORD = /^(?:chef'?s?\s+)?special$/;
const PICTO = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u;
const SEPARATOR = /\s[-–—|]\s/;
const LINE_PREFIX = new RegExp(`^\\s*(${DIET_WORD_RE})\\s*[:=]\\s*`, 'i');

const NON_VEG_WORDS = /\b(chicken|mutton|lamb|fish|prawns?|shrimps?|crab|beef|pork|bacon|sausages?|keema|kebabs?|salami|squid|turkey)\b/i;
const MEATLESS_WORDS = /\b(soya|soy|veg|mock|paneer|mushroom|jackfruit)\b/i;
const EGG_WORDS = /\b(eggs?|omelette|omelet|bhurji|frittata)\b/i;

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

const cleanLine = (raw: string) => raw.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\u00a0\t]/g, ' ').trim();
const headingCore = (line: string) => line.replace(/^[^\p{L}\p{N}&]+/u, '').replace(/[^\p{L}\p{N}&)\]]+$/u, '');

// "Lunch (12:30 - 2:30 pm)", "Dinner menu", "Lunch @ 1pm" -> lunch
function mealWord(core: string) {
  const stripped = core
    .replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '')
    .replace(/\s*[@\-–—]?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?(?:\s*(?:-|–|—|to)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)?$/i, '')
    .replace(/\s+menu$/i, '')
    .trim();
  return MEAL_ALIASES.get(canon(stripped));
}

export function dishKey(meal: string, name: string) {
  return `${meal}|${name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

const sentenceCase = (name: string) => {
  const letters = name.match(/\p{L}/gu) ?? [];
  const shouting = letters.length >= 4 && !/\p{Ll}/u.test(name);
  const value = shouting ? name.toLowerCase() : name;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

// Splits on commas and semicolons that are not inside brackets; "\," keeps a literal comma.
function splitTopLevel(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text.replace(/\\,/g, '\u0001')) {
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || char === ';')) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.replace(/\u0001/g, ',')).filter((part) => part.trim());
}

interface Piece { name: string; note: string; diet: DietId | null; conflict: boolean; special: boolean; emoji: string }

function parsePiece(source: string, lineDiet: DietId | null): Piece {
  let text = ` ${source} `;
  const diets: DietId[] = [];
  let special = false;
  const notes: string[] = [];

  // Brackets that hold only a diet word or "special" are marks; any other brackets become notes.
  text = text.replace(/[(\[]([^()[\]]*)[)\]]/g, (_all, inner: string) => {
    const word = clean(inner).toLowerCase();
    if (dietOf(word)) { diets.push(dietOf(word)!); return ' '; }
    if (SPECIAL_WORD.test(word) || word === 'sp') { special = true; return ' '; }
    const parts = word.split(/\s*[,/]\s*/);
    if (parts.length > 1 && parts.every((part) => dietOf(part) || part === 'special')) {
      for (const part of parts) { const diet = dietOf(part); if (diet) diets.push(diet); else special = true; }
      return ' ';
    }
    if (inner.trim()) notes.push(clean(inner));
    return ' ';
  });
  text = text.replace(DIET_EMOJI_RE, (match) => { diets.push(DIET_EMOJI[match.replace('\uFE0F', '')]); return ' '; });
  if (SPECIAL_TEST.test(text)) { special = true; text = text.replace(SPECIAL_MARKS, ' '); }

  // A "v:" style prefix and a bare trailing "v" / "nv".
  const prefix = LINE_PREFIX.exec(text);
  if (prefix) { diets.push(dietOf(prefix[1]) ?? 'veg'); text = text.slice(prefix[0].length); }
  const trailing = /\s(v|nv)\s*$/i.exec(text);
  if (trailing && clean(text).length > trailing[1].length + 1) { diets.push(dietOf(trailing[1])!); text = text.slice(0, trailing.index); }

  // A note after " - " (a note that is only a diet word, like "Idli - v", is a mark instead).
  let name = clean(text);
  const padded = ` ${name} `;
  const separator = SEPARATOR.exec(padded);
  if (separator) {
    const note = clean(padded.slice(separator.index + separator[0].length));
    name = clean(padded.slice(0, separator.index));
    const word = note.toLowerCase();
    if (dietOf(word)) diets.push(dietOf(word)!);
    else if (SPECIAL_WORD.test(word)) special = true;
    else if (note) notes.unshift(note);
  }

  // A leading or trailing emoji stays with the dish.
  let emoji = '';
  const leading = new RegExp(`^(${PICTO.source})\\s*`, 'u').exec(name);
  if (leading) { emoji = leading[1].replace(/\uFE0F$/, ''); name = name.slice(leading[0].length); }
  const ending = new RegExp(`\\s*(${PICTO.source})$`, 'u').exec(name);
  if (ending) { if (!emoji) emoji = ending[1].replace(/\uFE0F$/, ''); name = name.slice(0, ending.index); }
  name = clean(name.replace(/^[\s\-–—•·:.,;!*_#>]+|[\s\-–—:.,;!*_]+$/gu, ''));

  const distinct = [...new Set(diets)];
  return { name: sentenceCase(name), note: clean(notes.join(', ')), diet: distinct[0] ?? lineDiet, conflict: distinct.length > 1, special, emoji };
}

interface Head { line: number; label: string; count: number }

export function parseMenuText(input: string, options: { defaultMeal?: MealId } = {}): ParseResult {
  const items: ParsedDish[] = [];
  const warnings: ParseWarning[] = [];
  const warn = (line: number, message: string, level: 'warn' | 'info' = 'warn') => warnings.push({ line, level, message });
  let meal: MealId | null = null;
  let course: CourseId = 'mains';
  const heads: { meal: Head | null; course: Head | null } = { meal: null, course: null };
  const seen = new Map<string, number>();
  let unmarked = 0;
  let firstUnmarked = 0;
  let truncated = false;

  const empty = (head: Head | null) => {
    if (head && head.count === 0) warn(head.line, `“${head.label}” has no dishes. If it is a dish, add it with a bullet (- ${head.label}) or a mark such as (v).`, 'info');
  };
  const openCourse = (line: number, label: string) => { empty(heads.course); heads.course = { line, label, count: 0 }; };
  const openMeal = (line: number, label: string) => { empty(heads.course); heads.course = null; empty(heads.meal); heads.meal = { line, label, count: 0 }; };
  const assumeMeal = (line: number): MealId => {
    const assumed = options.defaultMeal ?? 'lunch';
    warn(line, `No meal heading before this, so the dishes go under ${MEALS[assumed].label}.`, 'info');
    openMeal(line, MEALS[assumed].label);
    return assumed;
  };

  input.split(/\r\n|\r|\n|\u2028|\u2029/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = cleanLine(rawLine);
    if (!line || line.startsWith('//')) return;
    if (/^[\s\-–—_=*~·.•#|━─═]{3,}$/u.test(line)) return;

    const bulleted = BULLET.test(line);
    let rest = line;
    let handled = false;

    if (!DIET_EMOJI_START.test(line)) {
      // "Lunch", "== Lunch ==", "Lunch:", "Lunch: Idli, Vada" and the same for sections.
      const colon = line.indexOf(':');
      const whole = headingCore(line);
      const left = colon > 0 ? headingCore(line.slice(0, colon)) : '';
      const afterColon = colon > 0 ? line.slice(colon + 1).trim() : '';
      const candidates: { core: string; rest: string }[] = [];
      if (!bulleted && whole.length > 0 && whole.length <= 40) candidates.push({ core: whole, rest: '' });
      if (left.length > 0 && left.length <= 40) candidates.push({ core: left, rest: afterColon });
      for (const candidate of candidates) {
        const mealId = mealWord(candidate.core);
        const courseId = mealId ? undefined : COURSE_ALIASES.get(canon(candidate.core));
        if (mealId) {
          meal = mealId; course = 'mains';
          openMeal(lineNumber, MEALS[mealId].label);
        } else if (courseId) {
          if (!meal) meal = assumeMeal(lineNumber);
          course = courseId;
          openCourse(lineNumber, COURSES[courseId].label);
        } else continue;
        rest = candidate.rest; handled = true; break;
      }
      // "Chaats:" is a section we do not know: its dishes go under Others.
      if (!handled && left && !afterColon && !/[,;]/.test(left) && !dietOf(left)) {
        if (!meal) meal = assumeMeal(lineNumber);
        course = 'others';
        warn(lineNumber, `Unknown section “${left}”: its dishes are saved under Others. Known sections: ${COURSE_IDS.map((id) => COURSES[id].label).join(', ')}.`);
        openCourse(lineNumber, COURSES.others.label);
        rest = '';
        handled = true;
      }
    }
    if (handled && !rest) return;

    let body = rest;
    for (let pass = 0; pass < 2; pass += 1) body = body.replace(BULLET, '');
    // A "v:" / "nv:" prefix marks every dish on its line that has no mark of its own.
    let lineDiet: DietId | null = null;
    const prefix = LINE_PREFIX.exec(body);
    if (prefix && body.slice(prefix[0].length).trim()) {
      lineDiet = dietOf(prefix[1]) ?? 'veg';
      body = body.slice(prefix[0].length);
    }
    // "🟢 Rice 🟡 Boiled egg": when a line starts with a dot and has no commas, every dot starts a new dish.
    if (DIET_EMOJI_START.test(body.trim()) && !/[,;]/.test(body)) body = body.replace(DIET_EMOJI_SPLIT, ',');
    for (const piece of splitTopLevel(body.replace(/\s[•·]\s/g, ','))) {
      const parsed = parsePiece(piece, lineDiet);
      if (!parsed.name) {
        if (clean(piece).replace(/[^\p{L}\p{N}]/gu, '')) warn(lineNumber, `“${clean(piece)}” has no dish name, so it was skipped.`);
        continue;
      }
      if (!meal) meal = assumeMeal(lineNumber);
      let name = parsed.name;
      if (name.length > NAME_MAX) { name = clean(name.slice(0, NAME_MAX)); warn(lineNumber, `“${name}…” was cut to ${NAME_MAX} characters.`); }
      let note = parsed.note;
      if (note.length > NOTE_MAX) { note = clean(note.slice(0, NOTE_MAX)); warn(lineNumber, `The note on “${name}” was cut to ${NOTE_MAX} characters.`); }
      if (parsed.conflict) warn(lineNumber, `“${name}” has conflicting diet marks; the first one was used.`);
      let diet = parsed.diet;
      const marked = diet !== null;
      if (!diet) {
        if (NON_VEG_WORDS.test(name) && !MEATLESS_WORDS.test(name)) { diet = 'non-veg'; warn(lineNumber, `“${name}” was marked non-veg because of its name. Add (v) to change it.`, 'info'); }
        else if (EGG_WORDS.test(name)) { diet = 'egg'; warn(lineNumber, `“${name}” was marked egg because of its name. Add (v) to change it.`, 'info'); }
        else { diet = 'veg'; unmarked += 1; if (!firstUnmarked) firstUnmarked = lineNumber; }
      }
      const key = dishKey(meal, name);
      if (seen.has(key)) { warn(lineNumber, `“${name}” is already in ${MEALS[meal].label} (line ${seen.get(key)}), so the repeat was skipped.`); continue; }
      if (items.length >= MAX_DAY_ITEMS) {
        if (!truncated) { truncated = true; warn(lineNumber, `A day can have up to ${MAX_DAY_ITEMS} dishes. The rest were left out.`); }
        continue;
      }
      seen.set(key, lineNumber);
      if (heads.meal) heads.meal.count += 1;
      if (heads.course) heads.course.count += 1;
      items.push({ meal, course, name, diet, note, special: parsed.special, emoji: parsed.emoji, line: lineNumber, dietMarked: marked });
    }
  });
  empty(heads.course);
  empty(heads.meal);
  if (unmarked > 0) warn(firstUnmarked, `${unmarked} ${unmarked === 1 ? 'dish has' : 'dishes have'} no veg / non-veg mark and ${unmarked === 1 ? 'is' : 'are'} saved as veg. Add (nv), (egg) or (vegan) where needed.`, 'info');
  warnings.sort((a, b) => a.line - b.line);
  return { items: sortMenuItems(items), warnings };
}

// Stable: meals in the order of the day, sections in menu order, and the typed order inside a section.
export function sortMenuItems<T extends { meal: MealId; course: CourseId }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => MEAL_IDS.indexOf(a.item.meal) - MEAL_IDS.indexOf(b.item.meal) || COURSE_IDS.indexOf(a.item.course) - COURSE_IDS.indexOf(b.item.course) || a.index - b.index)
    .map(({ item }) => item);
}

// Turns the structured dishes back into the text syntax, so the text box always shows what the grid holds.
export function formatMenuText(items: DraftDish[]): string {
  const blocks: string[] = [];
  for (const meal of MEAL_IDS) {
    const inMeal = items.filter((item) => item.meal === meal);
    if (!inMeal.length) continue;
    const lines = [MEALS[meal].label];
    const courses = COURSE_IDS.filter((course) => inMeal.some((item) => item.course === course));
    for (const course of courses) {
      if (course !== 'mains' || courses.length > 1) lines.push(`${COURSES[course].label}:`);
      for (const item of inMeal.filter((entry) => entry.course === course)) {
        const name = item.name.replace(/,/g, '\\,').replace(/\s[-–—|]\s/g, '-').replace(/\(/g, '[').replace(/\)/g, ']');
        const note = item.note.replace(/\s+/g, ' ').trim();
        // A note with commas goes in brackets so it cannot be mistaken for more dishes.
        const noteText = !note ? '' : /[,;]/.test(note) ? ` (${note.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim()})` : ` - ${note}`;
        lines.push(`${item.emoji ? `${item.emoji} ` : ''}${name} (${DIETS[item.diet].short})${item.special ? ' ★' : ''}${noteText}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

// Gives parsed dishes the ids of dishes that were already there (same meal and name), so likes and ratings survive a re-type.
export function reconcileIds<T extends { meal: MealId; name: string }>(parsed: T[], pool: { id?: string; meal: MealId; name: string }[]): (T & { id?: string })[] {
  const free = new Map<string, string[]>();
  for (const entry of pool) {
    if (!entry.id) continue;
    const key = dishKey(entry.meal, entry.name);
    const list = free.get(key) ?? [];
    if (!list.includes(entry.id)) list.push(entry.id);
    free.set(key, list);
  }
  const used = new Set<string>();
  return parsed.map((item) => {
    const id = free.get(dishKey(item.meal, item.name))?.find((candidate) => !used.has(candidate));
    if (id) used.add(id);
    return id ? { ...item, id } : { ...item };
  });
}

// Compact string of everything that gets saved, for "has anything changed?".
export const menuSignature = (items: DraftDish[]) => JSON.stringify(sortMenuItems(items).map((item) => [item.meal, item.course, item.name, item.diet, item.note, item.special ? 1 : 0, item.emoji]));
