import type { MenuDish } from './menuData';
import { COURSE_IDS, COURSES, MEAL_IDS, MEALS, type DietId, type MealId } from './menuCatalog';

// The standard PDF fonts only cover Latin-1, so curly quotes and dashes are mapped to plain ones and anything else
// (emoji, other scripts) is dropped instead of turning into "?" boxes.
export function pdfSafe(value: string) {
  return value
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201a]/g, "'").replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...').replace(/[\u00b7\u2022\u25cf]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '').replace(/\s+/g, ' ').trim();
}

const INK: [number, number, number] = [44, 34, 26];
const GOLD: [number, number, number] = [166, 128, 54];
const MUTED: [number, number, number] = [120, 105, 90];
const DIET_RGB: Record<DietId, [number, number, number]> = { veg: [47, 158, 63], 'non-veg': [190, 45, 45], egg: [214, 163, 0], vegan: [10, 143, 106] };

type Line =
  | { kind: 'meal'; meal: MealId; text: string }
  | { kind: 'course'; meal: MealId; text: string }
  | { kind: 'dish'; meal: MealId; item: MenuDish; name: string; note: string };
// Millimetres at full size. A dish with a note gets an extra line for it.
const HEIGHT = { meal: 14, course: 8, dish: 6, note: 4.4 };
const lineHeight = (line: Line) => (line.kind === 'dish' ? HEIGHT.dish + (line.note ? HEIGHT.note : 0) : HEIGHT[line.kind]);
const heightOf = (lines: Line[]) => lines.reduce((sum, line) => sum + lineHeight(line), 0);

// One framed page with every meal of the day. A short day is one centred column; a longer day is split into two columns at
// a meal or section heading, and the type shrinks a little to fit. A very long menu continues on a second page.
export async function buildMenuPdf({ appName, dateLabel, items }: { appName: string; dateLabel: string; items: MenuDish[] }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const flat: Line[] = [];
  for (const meal of MEAL_IDS) {
    const inMeal = items.filter((item) => item.meal === meal);
    if (!inMeal.length) continue;
    flat.push({ kind: 'meal', meal, text: MEALS[meal].label });
    for (const course of COURSE_IDS) {
      const inCourse = inMeal.filter((item) => item.course === course);
      if (!inCourse.length) continue;
      flat.push({ kind: 'course', meal, text: COURSES[course].label });
      for (const item of inCourse) flat.push({ kind: 'dish', meal, item, name: pdfSafe(item.name) || '-', note: pdfSafe(item.description) });
    }
  }

  const frame = () => {
    doc.setDrawColor(...GOLD).setLineWidth(0.9).rect(9, 9, pageW - 18, pageH - 18);
    doc.setLineWidth(0.25).rect(11.5, 11.5, pageW - 23, pageH - 23);
  };
  const diamondDivider = (y: number, width = 46) => {
    const cx = pageW / 2;
    doc.setDrawColor(...GOLD).setLineWidth(0.3);
    doc.line(cx - width, y, cx - 4, y);
    doc.line(cx + 4, y, cx + width, y);
    doc.setFillColor(...GOLD).triangle(cx - 2.2, y, cx, y - 2.2, cx + 2.2, y, 'F').triangle(cx - 2.2, y, cx, y + 2.2, cx + 2.2, y, 'F');
  };

  frame();
  doc.setFont('times', 'normal').setFontSize(9).setTextColor(...GOLD);
  doc.text(pdfSafe(appName).toUpperCase(), pageW / 2, 24, { align: 'center', charSpace: 1.6 });
  doc.setFont('times', 'bold').setFontSize(30).setTextColor(...INK).text('Menu', pageW / 2, 36, { align: 'center' });
  doc.setFont('times', 'italic').setFontSize(12).setTextColor(...MUTED).text(pdfSafe(dateLabel), pageW / 2, 43, { align: 'center' });
  diamondDivider(49);

  const top = 58;
  const bottom = pageH - 27;
  const avail = bottom - top;
  const total = heightOf(flat);
  let columns: Line[][] = [flat];
  if (total > avail) {
    let cut = -1;
    let worst = Infinity;
    let before = 0;
    flat.forEach((line, index) => {
      if (index > 0 && line.kind !== 'dish') {
        const candidate = Math.max(before, total - before);
        if (candidate < worst) { worst = candidate; cut = index; }
      }
      before += lineHeight(line);
    });
    if (cut > 0) {
      const second = flat.slice(cut);
      // A column that starts in the middle of a meal repeats the meal's name so it is clear where it belongs.
      if (second[0].kind === 'course') second.unshift({ kind: 'meal', meal: second[0].meal, text: `${MEALS[second[0].meal].label} (continued)` });
      columns = [flat.slice(0, cut), second];
    }
  }
  const tallest = Math.max(...columns.map(heightOf), 1);
  const scale = Math.min(1, Math.max(0.62, avail / tallest));
  const columnW = (pageW - 40) / columns.length;
  const fit = (value: string, maxWidth: number) => {
    let out = value;
    while (out.length > 1 && doc.getTextWidth(out) > maxWidth) out = `${out.slice(0, -2).trimEnd()}...`;
    return out;
  };

  columns.forEach((column, columnIndex) => {
    const cx = 20 + columnW * columnIndex + columnW / 2;
    let y = top;
    let page = 1;
    const room = (needed: number) => {
      if (y + needed <= bottom) return;
      page += 1;
      if (page > doc.getNumberOfPages()) { doc.addPage(); frame(); } else doc.setPage(page);
      y = 24;
    };
    doc.setPage(1);
    for (const line of column) {
      room(lineHeight(line) * scale);
      if (line.kind === 'meal') {
        y += 5 * scale;
        doc.setFont('times', 'bold').setFontSize(15 * scale).setTextColor(...INK);
        doc.text(fit(line.text.toUpperCase(), columnW - 6), cx, y + 2, { align: 'center', charSpace: 1.2 });
        doc.setDrawColor(...GOLD).setLineWidth(0.3).line(cx - 14, y + 4.6 * scale, cx + 14, y + 4.6 * scale);
        y += (HEIGHT.meal - 5) * scale;
      } else if (line.kind === 'course') {
        doc.setFont('times', 'italic').setFontSize(9.5 * scale).setTextColor(...GOLD).text(line.text.toUpperCase(), cx, y + 3.4 * scale, { align: 'center', charSpace: 1 });
        y += HEIGHT.course * scale;
      } else {
        doc.setFont('times', line.item.special ? 'bold' : 'normal').setFontSize(11 * scale).setTextColor(...INK);
        const mark = 3.2 * scale;
        const name = fit(line.name, columnW - 16);
        const width = mark + 2.2 + doc.getTextWidth(name) + (line.item.special ? 5 * scale : 0);
        const x = cx - width / 2;
        const baseline = y + 4.2 * scale;
        const [r, g, b] = DIET_RGB[line.item.diet];
        doc.setDrawColor(r, g, b).setLineWidth(0.3).rect(x, baseline - mark + 0.3, mark, mark);
        doc.setFillColor(r, g, b).circle(x + mark / 2, baseline - mark / 2 + 0.3, mark * 0.22, 'F');
        doc.text(name, x + mark + 2.2, baseline);
        if (line.item.special) doc.setFillColor(...GOLD).circle(x + width - 1.4 * scale, baseline - 1.5 * scale, 1.05 * scale, 'F');
        y += HEIGHT.dish * scale;
        if (line.note) {
          doc.setFont('times', 'italic').setFontSize(8.5 * scale).setTextColor(...MUTED);
          doc.text(fit(line.note, columnW - 10), cx, y + 1.2 * scale, { align: 'center' });
          y += HEIGHT.note * scale;
        }
      }
    }
  });

  // Legend and footer on the first page.
  doc.setPage(1);
  const legendY = pageH - 19;
  doc.setFont('times', 'normal').setFontSize(8).setTextColor(...MUTED);
  const legend: [DietId, string][] = [['veg', 'Vegetarian'], ['non-veg', 'Non-vegetarian'], ['egg', 'Contains egg'], ['vegan', 'Vegan']];
  const widths = legend.map(([, label]) => 5 + doc.getTextWidth(label) + 6);
  let lx = pageW / 2 - widths.reduce((a, b) => a + b, 0) / 2;
  legend.forEach(([diet, label], index) => {
    const [r, g, b] = DIET_RGB[diet];
    doc.setDrawColor(r, g, b).setLineWidth(0.3).rect(lx, legendY - 2.6, 3, 3);
    doc.setFillColor(r, g, b).circle(lx + 1.5, legendY - 1.1, 0.7, 'F');
    doc.text(label, lx + 4.5, legendY);
    lx += widths[index];
  });
  diamondDivider(pageH - 14.5, 24);
  return doc;
}

export async function downloadMenuPdf(options: { appName: string; date: string; dateLabel: string; items: MenuDish[] }) {
  (await buildMenuPdf(options)).save(`menu-${options.date}.pdf`);
}
