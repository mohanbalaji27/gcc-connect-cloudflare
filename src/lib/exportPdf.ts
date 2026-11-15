import { jsPDF } from 'jspdf';
import type { Resource, Team } from './types';
import type { FloorPlanImage } from './floorplan';

const hexToRgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const safe = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');

export function exportTeamLayoutPdf(plan: FloorPlanImage | null, resources: Resource[], teams: Team[], title = 'GCC office seating by team') {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const legendW = 78;
  const headerH = 14;
  const aspect = plan ? plan.width / plan.height : 1684 / 1191;
  const mapMaxW = pageW - margin * 2 - legendW - 6;
  const mapMaxH = pageH - margin * 2 - headerH;
  const mapW = Math.min(mapMaxW, mapMaxH * aspect);
  const mapH = mapW / aspect;
  const mapX = margin;
  const mapY = margin + headerH;

  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(22, 63, 49);
  doc.text(safe(title), margin, margin + 7);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110, 120, 115);
  doc.text(`Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, margin, margin + 12);

  if (plan) doc.addImage(plan.canvas.toDataURL('image/jpeg', 0.92), 'JPEG', mapX, mapY, mapW, mapH);
  else doc.setDrawColor(210, 215, 208).rect(mapX, mapY, mapW, mapH);

  const desks = resources.filter((resource) => resource.type === 'desk' && resource.x !== null && resource.y !== null);
  const radius = Math.max(1.15, mapW / 330);
  for (const desk of desks) {
    const [r, g, b] = hexToRgb(desk.team?.color ?? '#9aa39e');
    doc.setFillColor(r, g, b).setDrawColor(255, 255, 255).setLineWidth(0.25);
    doc.circle(mapX + (desk.x! / 100) * mapW, mapY + (desk.y! / 100) * mapH, radius, 'FD');
  }
  doc.setFontSize(Math.max(3.2, radius * 1.8)).setTextColor(20, 20, 20);
  for (const desk of desks) {
    doc.text(safe(desk.label.replace(/^Z/, '')), mapX + (desk.x! / 100) * mapW, mapY + (desk.y! / 100) * mapH + radius * 2.7, { align: 'center' });
  }

  const legendX = pageW - margin - legendW;
  let y = mapY;
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(22, 63, 49).text('Teams', legendX, y + 3);
  y += 8;
  const counts = new Map<string, number>();
  for (const desk of resources.filter((resource) => resource.type === 'desk')) counts.set(desk.team?.id ?? 'none', (counts.get(desk.team?.id ?? 'none') ?? 0) + 1);
  const rows: { name: string; color: string; count: number }[] = teams.map((team) => ({ name: team.name, color: team.color, count: counts.get(team.id) ?? 0 }));
  if (counts.get('none')) rows.push({ name: 'Unassigned', color: '#9aa39e', count: counts.get('none')! });
  doc.setFont('helvetica', 'normal').setFontSize(9);
  for (const row of rows) {
    const [r, g, b] = hexToRgb(row.color);
    doc.setFillColor(r, g, b).roundedRect(legendX, y - 3, 4.5, 4.5, 1, 1, 'F');
    doc.setTextColor(30, 40, 35).text(safe(row.name), legendX + 7, y + 0.6);
    doc.setTextColor(110, 120, 115).text(String(row.count), legendX + legendW, y + 0.6, { align: 'right' });
    y += 6.2;
  }
  y += 2;
  doc.setDrawColor(220, 225, 218).line(legendX, y, legendX + legendW, y);
  doc.setTextColor(110, 120, 115).text(`${desks.length} desks shown on the plan`, legendX, y + 6);

  doc.addPage('a3', 'landscape');
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(22, 63, 49).text('Seat numbers by team', margin, margin + 6);
  const columnW = 88;
  const perRow = Math.max(1, Math.floor((pageW - margin * 2) / columnW));
  let col = 0;
  let rowTop = margin + 16;
  let rowHeight = 0;
  for (const row of rows) {
    const seats = resources.filter((resource) => resource.type === 'desk' && (row.name === 'Unassigned' ? !resource.team : resource.team?.name === row.name)).map((resource) => resource.label).sort();
    doc.setFont('helvetica', 'normal').setFontSize(8.5);
    const lines = doc.splitTextToSize(seats.join(', ') || 'No seats assigned', columnW - 8) as string[];
    const blockH = 9 + lines.length * 4;
    if (col === perRow) { col = 0; rowTop += rowHeight + 6; rowHeight = 0; }
    if (rowTop + blockH > pageH - margin) { doc.addPage('a3', 'landscape'); rowTop = margin + 6; col = 0; rowHeight = 0; }
    const x = margin + col * columnW;
    const [r, g, b] = hexToRgb(row.color);
    doc.setFillColor(r, g, b).roundedRect(x, rowTop - 3.5, 4.5, 4.5, 1, 1, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(22, 63, 49).text(`${safe(row.name)} (${row.count})`, x + 7, rowTop);
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(70, 80, 75).text(lines, x + 7, rowTop + 5);
    rowHeight = Math.max(rowHeight, blockH);
    col += 1;
  }
  doc.save('gcc-office-seating-by-team.pdf');
}
