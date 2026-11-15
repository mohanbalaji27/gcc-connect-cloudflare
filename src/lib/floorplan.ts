export interface FloorPlanImage { url: string; canvas: HTMLCanvasElement; width: number; height: number }

let pending: Promise<FloorPlanImage | null> | null = null;

export function loadFloorPlan(): Promise<FloorPlanImage | null> {
  pending ??= (async () => {
    const response = await fetch('/api/floor-plan', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const data = new Uint8Array(await response.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 3600 / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return { url: URL.createObjectURL(blob), canvas, width: canvas.width, height: canvas.height };
  })().catch(() => {
    pending = null;
    return null;
  });
  return pending;
}

export async function reloadFloorPlan(): Promise<FloorPlanImage | null> {
  const previous = pending;
  pending = null;
  const next = await loadFloorPlan();
  if (!next) {
    pending = previous;
    return previous ? previous : null;
  }
  previous?.then((image) => { if (image) setTimeout(() => URL.revokeObjectURL(image.url), 3000); });
  return next;
}

export function resetFloorPlan() {
  pending?.then((image) => image && URL.revokeObjectURL(image.url));
  pending = null;
}
