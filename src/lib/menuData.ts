import { api } from './api';
import type { CourseId, DietId, MealId, ReviewVisibility } from './menuCatalog';
import type { DraftDish } from './menuText';

export interface MenuDish {
  id: string; date: string; meal: MealId; course: CourseId; name: string; description: string; diet: DietId; emoji: string;
  special: boolean; likes: number; liked: boolean;
}
export interface Rating { avg: number | null; count: number }
export interface MyMealReview { rating: number; comment: string; anonymous: boolean }
export interface MenuWindow {
  from: string; to: string; today: string; historyDays: number; visibility: ReviewVisibility; canSeeReviews: boolean;
  items: MenuDish[];
  ratings: Record<string, Rating>; // "date|meal" -> average and count (left empty when this person may not see them)
  dishRatings: Record<string, Rating>;
  mine: { meals: Record<string, MyMealReview>; dishes: Record<string, number> };
}
export interface MealState { key: string; rating: Rating | null; dishRatings: Record<string, Rating>; mine: { meal: MyMealReview | null; dishes: Record<string, number> } }
export interface WrittenReview { id: string; rating: number; comment: string; anonymous: boolean; at: string; mine: boolean; author: string | null }

export const mealKey = (date: string, meal: string) => `${date}|${meal}`;

// One window (history + today + what is coming) is loaded once and kept in memory. The browser revalidates it with the
// server's ETag, so a repeat call is a tiny 304. Day and meal switching, likes and reviews never call the server for a refresh.
const FRESH_MS = 60_000;
let cached: { data: MenuWindow; at: number } | null = null;
let inflight: Promise<MenuWindow> | null = null;

export const peekMenu = () => cached?.data ?? null;
export const menuAge = () => (cached ? Date.now() - cached.at : Infinity);
export function clearMenu() { cached = null; inflight = null; }

export function loadMenu(force = false): Promise<MenuWindow> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.data);
  if (inflight) return inflight;
  inflight = api<MenuWindow>('/menu')
    .then((data) => { cached = { data, at: Date.now() }; return data; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function updateMenu(change: (window: MenuWindow) => MenuWindow): MenuWindow | null {
  if (!cached) return null;
  cached = { data: change(cached.data), at: cached.at };
  return cached.data;
}

export const withLike = (window: MenuWindow, id: string, liked: boolean): MenuWindow => ({
  ...window,
  items: window.items.map((item) => (item.id === id && item.liked !== liked ? { ...item, liked, likes: Math.max(0, item.likes + (liked ? 1 : -1)) } : item)),
});

// Merges the reply of a review save or delete: the new average for the meal and this person's own ratings.
export function withMealState(window: MenuWindow, state: MealState): MenuWindow {
  const ratings = { ...window.ratings };
  if (state.rating) ratings[state.key] = state.rating; else delete ratings[state.key];
  const [date, meal] = state.key.split('|');
  const meals = { ...window.mine.meals };
  if (state.mine.meal) meals[state.key] = state.mine.meal; else delete meals[state.key];
  const ids = new Set(window.items.filter((item) => item.date === date && item.meal === meal).map((item) => item.id));
  const dishes = Object.fromEntries(Object.entries(window.mine.dishes).filter(([id]) => !ids.has(id)));
  const dishRatings = Object.fromEntries(Object.entries(window.dishRatings).filter(([id]) => !ids.has(id)));
  return { ...window, ratings, dishRatings: { ...dishRatings, ...state.dishRatings }, mine: { meals, dishes: { ...dishes, ...state.mine.dishes } } };
}

export const toDraft = (item: { id?: string; meal: MealId; course: CourseId; name: string; description: string; diet: DietId; emoji: string; special: boolean }): DraftDish => ({
  id: item.id, meal: item.meal, course: item.course, name: item.name, diet: item.diet, note: item.description, special: item.special, emoji: item.emoji,
});
export const toPayload = (item: DraftDish) => ({ id: item.id, meal: item.meal, course: item.course, name: item.name, diet: item.diet, description: item.note, emoji: item.emoji, special: item.special });

export const starsText = (value: number | null) => (value === null ? '' : value.toFixed(1).replace(/\.0$/, ''));

// CSV cells that start with = + - @ would run as formulas in a spreadsheet, so they get a leading apostrophe.
export function csvCell(value: unknown) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
export const toCsv = (rows: unknown[][]) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
