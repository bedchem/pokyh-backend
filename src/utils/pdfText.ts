import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PdfTextItem } from './mensaPdf';

const PDF_TIMEOUT_MS = 20_000;
const PDF_MEMORY_MB = 256;

/** The text of a PDF by page, read in a limited thread of its own (workers/pdfTextWorker.ts). */
export function pdfTextItems(data: Buffer): Promise<PdfTextItem[][]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'pdfTextWorker.js'), {
      workerData: new Uint8Array(data),
      resourceLimits: { maxOldGenerationSizeMb: PDF_MEMORY_MB, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('pdf timeout'));
    }, PDF_TIMEOUT_MS);
    const done = (finish: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    worker.once('message', (m: { pages?: PdfTextItem[][]; error?: string }) => done(() => (m.pages ? resolve(m.pages) : reject(new Error(m.error ?? 'pdf')))));
    worker.once('error', (err) => done(() => reject(err)));
    worker.once('exit', () => done(() => reject(new Error('pdf reader stopped'))));
  });
}
