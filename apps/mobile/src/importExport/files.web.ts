/**
 * Web file access for import/export (testing build): a hidden file input, and
 * the export offered to the share sheet when the browser can share files
 * (mobile browsers), otherwise downloaded.
 */
import type { ImportFile } from '@triangulair/import';

export const IMPORT_ACCEPT = '.json,.geojson,.umap,.kml,.kmz,.zip,.csv,.tsv,.txt,application/json,application/geo+json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip,text/csv';

export function pickImportFile(): Promise<ImportFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_ACCEPT;
    input.style.display = 'none';
    input.setAttribute('data-testid', 'import-file-input');
    let settled = false;
    const done = (v: ImportFile | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return done(null);
      f.arrayBuffer()
        .then((buf) => done({ name: f.name, bytes: new Uint8Array(buf) }))
        .catch((e: unknown) => {
          settled = true;
          input.remove();
          reject(e);
        });
    });
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

export async function saveExportFile(name: string, data: string | Uint8Array, mimeType: string, dialogTitle: string): Promise<'shared' | 'downloaded'> {
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mimeType });
  const file = typeof File === 'function' ? new File([blob], name, { type: mimeType }) : null;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (file && coarse && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: dialogTitle });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return 'shared';
      // fall back to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.setAttribute('data-testid', 'export-download');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
