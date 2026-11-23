/**
 * Web (test build): a file input (`capture` on phones for the camera), then a canvas: the image is
 * decoded with its EXIF orientation applied, drawn at about 1,600 px and encoded in AVIF when the
 * browser can, else WebP, else JPEG; the thumbnail uses the same format. Both are made to fit the
 * format caps (`encodeToFit`: smaller quality, then smaller size; never refused for their size). A
 * canvas writes no metadata; the sync package strips and checks again (`Photos.add`).
 */
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, MAX_THUMB_BYTES, MAX_THUMB_SIDE, type PhotoInput } from '@triangulair/sync';

import { encodeToFit, fitSize, type QualitySpec } from './model';
import { PhotoProcessError, type Picked, type PickSource } from './pick.types';

const TYPES = ['image/avif', 'image/webp', 'image/jpeg'] as const;

export function pickImage(from: PickSource): Promise<Picked | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (from === 'camera') input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    input.setAttribute('data-testid', 'photo-file-input');
    let done = false;
    const finish = (v: Picked | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      finish(f ? { uri: '', width: 0, height: 0, file: f } : null);
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function decode(p: Picked): Promise<ImageBitmap> {
  const src = p.file ?? (await (await fetch(p.uri)).blob());
  try {
    return await createImageBitmap(src, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoProcessError('not an image this browser can read');
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function draw(bmp: ImageBitmap, side: number, quality: number, types: readonly string[]): Promise<{ bytes: Uint8Array; type: string; width: number; height: number }> {
  const { width, height } = fitSize(bmp.width, bmp.height, side);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoProcessError('no canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  for (const type of types) {
    const blob = await toBlob(canvas, type, quality);
    // A browser that cannot encode a type silently falls back to PNG: check what came out.
    if (blob && blob.type === type) return { bytes: new Uint8Array(await blob.arrayBuffer()), type, width, height };
  }
  throw new PhotoProcessError('this browser cannot encode WebP, AVIF or JPEG');
}

export async function processImage(p: Picked, q: QualitySpec): Promise<PhotoInput> {
  const bmp = await decode(p);
  try {
    let types: readonly string[] = TYPES;
    const full = await encodeToFit(
      async (side, quality) => {
        const out = await draw(bmp, side, quality, types);
        types = [out.type]; // the format the browser could encode, kept for the next tries and the thumbnail
        return out;
      },
      { side: q.side, quality: q.quality, maxSide: MAX_PHOTO_SIDE, maxBytes: MAX_PHOTO_BYTES },
    );
    const thumb = await encodeToFit((side, quality) => draw(bmp, side, quality, [full.type]), {
      side: q.thumbSide,
      quality: q.thumbQuality,
      maxSide: MAX_THUMB_SIDE,
      maxBytes: MAX_THUMB_BYTES,
    });
    return { full: full.bytes, thumb: thumb.bytes, width: full.width, height: full.height };
  } finally {
    bmp.close();
  }
}

/** A photo downloaded during an import (`Picked` from its bytes), processed like a picked one. */
export async function processDownloaded(bytes: Uint8Array, mime: string | undefined, q: QualitySpec): Promise<PhotoInput> {
  const file = new Blob([bytes as BlobPart], mime ? { type: mime } : {});
  return processImage({ uri: '', width: 0, height: 0, file }, q);
}
