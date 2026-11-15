#!/usr/bin/env node
// Finds every desk drawn on the floor-plan PDF (12 x 24 pt rectangles at any rotation) and
// matches them to the seats from the workbook grid, writing x/y (percent of the page) into
// local-data/seat-inventory.json. Review the result in the Map & teams editor and drag any
// seat that landed in the wrong place.
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const pdfPath = process.argv[2] ?? 'local-data/floor-plan.pdf';
const inventoryPath = process.argv[3] ?? 'local-data/seat-inventory.json';
const DESK_SHORT = Number(process.env.DESK_SHORT ?? 12);
const DESK_LONG = Number(process.env.DESK_LONG ?? 24);
const TOLERANCE = 0.6;

const doc = await getDocument({ data: new Uint8Array(readFileSync(pdfPath)) }).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
const list = await page.getOperatorList();
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const VALUES = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 };

let ctm = viewport.transform.slice();
const stack = [];
const desks = [];
for (let i = 0; i < list.fnArray.length; i += 1) {
  const fn = list.fnArray[i];
  const args = list.argsArray[i];
  if (fn === OPS.save) stack.push(ctm.slice());
  else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
  else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
  else if (fn === OPS.constructPath) {
    const data = args[1][0];
    const length = Object.keys(data).length;
    const points = [];
    let position = 0;
    let valid = true;
    while (position < length) {
      const op = data[position];
      if (VALUES[op] === undefined || (op !== 0 && op !== 1 && op !== 4)) { valid = false; break; }
      if (op !== 4) points.push(apply(ctm, data[position + 1], data[position + 2]));
      position += 1 + VALUES[op];
    }
    if (!valid) continue;
    let quad = points;
    if (quad.length === 5 && Math.hypot(quad[0][0] - quad[4][0], quad[0][1] - quad[4][1]) < 0.01) quad = quad.slice(0, 4);
    if (quad.length !== 4) continue;
    const edges = [0, 1, 2, 3].map((k) => Math.hypot(quad[k][0] - quad[(k + 1) % 4][0], quad[k][1] - quad[(k + 1) % 4][1])).sort((a, b) => a - b);
    if (edges.slice(0, 2).every((e) => Math.abs(e - DESK_SHORT) < TOLERANCE) && edges.slice(2).every((e) => Math.abs(e - DESK_LONG) < TOLERANCE)) {
      desks.push({ x: quad.reduce((t, p) => t + p[0], 0) / 4 / viewport.width, y: quad.reduce((t, p) => t + p[1], 0) / 4 / viewport.height });
    }
  }
}
console.log(`Found ${desks.length} desk shapes on the plan.`);

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const seats = inventory.seats.filter((seat) => Number.isInteger(seat.row) && Number.isInteger(seat.column));
if (!desks.length || seats.length !== desks.length) {
  console.log(`Seat count (${seats.length}) does not match desk shapes (${desks.length}); using the grid layout fallback instead.`);
  process.exit(desks.length ? 2 : 1);
}

const norm = (values) => {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  return values.map((v) => (v - min) / span);
};
const deskX = norm(desks.map((d) => d.x));
const deskY = norm(desks.map((d) => d.y));
const col = norm(seats.map((s) => s.column));
const row = norm(seats.map((s) => s.row));

// Hungarian algorithm (minimum cost assignment) on an n x n cost matrix.
function hungarian(cost) {
  const n = cost.length;
  const u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(n + 1).fill(Infinity);
    const used = Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) { minv[j] = current; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assignment = Array(n);
  for (let j = 1; j <= n; j += 1) assignment[p[j] - 1] = j - 1;
  return assignment;
}

const orientations = [];
for (const swap of [false, true]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
  orientations.push({ swap, flipX, flipY, name: `${swap ? 'transpose ' : ''}${flipX ? 'flipX ' : ''}${flipY ? 'flipY' : ''}`.trim() || 'identity' });
}
let best = null;
for (const o of orientations) {
  const sx = seats.map((_, i) => { let value = o.swap ? row[i] : col[i]; return o.flipX ? 1 - value : value; });
  const sy = seats.map((_, i) => { let value = o.swap ? col[i] : row[i]; return o.flipY ? 1 - value : value; });
  const cost = sx.map((x, i) => desks.map((_, j) => (x - deskX[j]) ** 2 + (sy[i] - deskY[j]) ** 2));
  const assignment = hungarian(cost);
  const total = assignment.reduce((sum, j, i) => sum + cost[i][j], 0);
  if (!best || total < best.total) best = { total, assignment, name: o.name };
}
console.log(`Best orientation: ${best.name} (cost ${best.total.toFixed(2)}).`);

seats.forEach((seat, i) => {
  const desk = desks[best.assignment[i]];
  seat.x = Math.round(desk.x * 10000) / 100;
  seat.y = Math.round(desk.y * 10000) / 100;
});
writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2), 'utf8');
console.log(`Wrote plan positions for ${seats.length} seats to ${inventoryPath}.`);
