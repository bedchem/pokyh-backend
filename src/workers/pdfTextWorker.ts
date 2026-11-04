import { parentPort, workerData } from 'node:worker_threads';

// Reads the text of a PDF with its place on the page, in a thread of its own:
// a PDF from a source is hostile until proven otherwise, and this thread can be
// limited in memory and killed (utils/pdfText.ts). Only text is read: no fonts,
// no scripts, no rendering.

const MAX_PAGES = 4;

// The library is an ES module and this file is compiled to CommonJS, which
// would turn a plain import() into a require().
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

// Needed by the library's rendering code when it loads, never called for text.
const globals = globalThis as Record<string, unknown>;
for (const name of ['DOMMatrix', 'Path2D', 'ImageData']) {
  if (!globals[name]) globals[name] = class {};
}

async function read(data: Uint8Array) {
  const pdfjs = await importModule(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    pages.push(items
      .filter((item: { str?: string }) => typeof item.str === 'string' && item.str.trim())
      .map((item: { str: string; transform: number[]; width: number }) => {
        // Where it stands as the page is shown; some are stored turned sideways.
        const [a, b, c, d, e, f] = viewport.transform as number[];
        const [px, py] = [item.transform[4], item.transform[5]];
        const x = a * px + c * py + e;
        const y = b * px + d * py + f;
        return { str: item.str, x, y, width: item.width };
      }));
  }
  await task.destroy();
  return pages;
}

read(workerData as Uint8Array).then(
  (pages) => parentPort!.postMessage({ pages }),
  (err) => parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) }),
);
