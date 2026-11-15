// Initial seat placement from the workbook grid onto the floor-plan image, in percent of the image.
export const DEFAULT_CALIBRATION = { x0: 8, y0: 8, x1: 92, y1: 92 };

export function validCalibration(value) {
  if (!value || typeof value !== 'object') return false;
  const { x0, y0, x1, y1 } = value;
  return [x0, y0, x1, y1].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100) && x1 - x0 >= 5 && y1 - y0 >= 5;
}

export function gridPlacement(seats, calibration) {
  const placed = seats.filter((seat) => Number.isInteger(seat.row) && Number.isInteger(seat.col));
  const result = new Map();
  if (!placed.length) return result;
  const rows = placed.map((seat) => seat.row);
  const cols = placed.map((seat) => seat.col);
  const [minRow, maxRow, minCol, maxCol] = [Math.min(...rows), Math.max(...rows), Math.min(...cols), Math.max(...cols)];
  const spanRow = Math.max(1, maxRow - minRow);
  const spanCol = Math.max(1, maxCol - minCol);
  for (const seat of placed) {
    result.set(seat.id, {
      x: Math.round((calibration.x0 + ((seat.col - minCol) / spanCol) * (calibration.x1 - calibration.x0)) * 100) / 100,
      y: Math.round((calibration.y0 + ((seat.row - minRow) / spanRow) * (calibration.y1 - calibration.y0)) * 100) / 100,
    });
  }
  return result;
}
