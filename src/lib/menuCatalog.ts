// The food menu catalogue (the server has the same lists in server/menu-catalog.js; a test keeps them identical).
// To add a section: add its id to COURSE_IDS and its label (plus words people may type for it) to COURSES.
export const MEAL_IDS = ['breakfast', 'lunch', 'snacks', 'dinner'] as const; // chronological; "snacks" is shown as "Evening snacks"
export type MealId = (typeof MEAL_IDS)[number];
export const COURSE_IDS = ['starters', 'mains', 'breads-rice', 'sides', 'desserts', 'drinks', 'others'] as const;
export type CourseId = (typeof COURSE_IDS)[number];
export const DIET_IDS = ['veg', 'non-veg', 'egg', 'vegan'] as const; // also the order a diet dot cycles through
export type DietId = (typeof DIET_IDS)[number];
export type ReviewVisibility = 'everyone' | 'summary' | 'managers';
export const REVIEW_VISIBILITY_IDS: ReviewVisibility[] = ['everyone', 'summary', 'managers'];

export const MAX_DAY_ITEMS = 300;
export const NAME_MAX = 80;
export const NOTE_MAX = 120;
export const COMMENT_MAX = 280;

export const MEALS: Record<MealId, { label: string; emoji: string; words: string[] }> = {
  breakfast: { label: 'Breakfast', emoji: '🥞', words: ['breakfast', 'morning'] },
  lunch: { label: 'Lunch', emoji: '🍛', words: ['lunch'] },
  snacks: { label: 'Evening snacks', emoji: '🍪', words: ['evening snacks', 'evening snack', 'snacks', 'snack', 'tea time', 'tea-time', 'teatime', 'high tea', 'evening'] },
  dinner: { label: 'Dinner', emoji: '🌙', words: ['dinner', 'supper'] },
};
export const COURSES: Record<CourseId, { label: string; words: string[] }> = {
  starters: { label: 'Starters', words: ['starters', 'starter', 'appetizers', 'appetizer', 'appetisers', 'appetiser', 'soups', 'soup', 'snacks and starters'] },
  mains: { label: 'Mains', words: ['mains', 'main', 'main course', 'main dish', 'main dishes', 'entree', 'entrees', 'curries', 'curry', 'gravies'] },
  'breads-rice': { label: 'Breads & rice', words: ['breads & rice', 'breads and rice', 'bread & rice', 'bread and rice', 'rice & breads', 'rice and breads', 'rice & bread', 'rice and bread', 'breads', 'bread', 'rice', 'rotis', 'roti', 'rice & roti', 'rice and roti'] },
  sides: { label: 'Sides', words: ['sides', 'side', 'side dish', 'side dishes', 'accompaniments', 'accompaniment', 'salads', 'salad'] },
  desserts: { label: 'Desserts', words: ['desserts', 'dessert', 'sweets', 'sweet', 'sweet dish', 'sweet dishes'] },
  drinks: { label: 'Drinks', words: ['drinks', 'drink', 'beverages', 'beverage', 'juices', 'juice'] },
  others: { label: 'Others', words: ['others', 'other', 'misc', 'miscellaneous', 'extras', 'extra'] },
};
export const DIETS: Record<DietId, { label: string; short: string }> = {
  veg: { label: 'Veg', short: 'v' },
  'non-veg': { label: 'Non-veg', short: 'nv' },
  egg: { label: 'Egg', short: 'egg' },
  vegan: { label: 'Vegan', short: 'vegan' },
};

export const nextDiet = (diet: DietId): DietId => DIET_IDS[(DIET_IDS.indexOf(diet) + 1) % DIET_IDS.length];

// Which meal people are most likely looking for at this time (India time): used to open the menu on the right tab.
export function currentMeal(hour: number, minute = 0): MealId {
  const minutes = hour * 60 + minute;
  if (minutes < 10 * 60 + 30) return 'breakfast';
  if (minutes < 15 * 60) return 'lunch';
  if (minutes < 18 * 60) return 'snacks';
  return 'dinner';
}
