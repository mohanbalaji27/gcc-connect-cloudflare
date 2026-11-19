// The food menu catalogue. The browser has the same lists in src/lib/menuCatalog.ts (a test keeps them identical).
// To add a section (course), add it to COURSES and COURSE_LABELS here and in the browser file, nothing else.
export const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner']; // chronological; "snacks" is shown as "Evening snacks"
export const COURSES = ['starters', 'mains', 'breads-rice', 'sides', 'desserts', 'drinks', 'others'];
export const DIETS = ['veg', 'non-veg', 'egg', 'vegan'];
export const REVIEW_VISIBILITY = ['everyone', 'summary', 'managers'];

export const MAX_DAY_ITEMS = 300;
export const NAME_MAX = 80;
export const NOTE_MAX = 120;
export const COMMENT_MAX = 280;
export const MAX_TEMPLATES = 30;
export const MAX_COPY_DATES = 14;

export const DEFAULT_MENU_SETTINGS = { menuReviewsVisibility: 'summary', menuHistoryDays: 7 };
