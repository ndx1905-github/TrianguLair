/**
 * Phone: the camera or the photo library (expo-image-picker), then recompression with
 * expo-image-manipulator: about 1,600 px WebP and a thumbnail, always made to fit the format caps
 * (`encodeToFit`: smaller quality, then smaller size; a photo is never refused for its size). Re-encoding writes no EXIF (no GPS,
 * no device model); the sync package strips and checks again before storing (`Photos.add`). The
 * original never leaves the picker's temporary file, and that file (a copy with its EXIF and GPS, in
 * the app's cache folder, outside the encrypted database) is deleted once processed, as are the
 * manipulator's output files (review photos F-04). AVIF: expo-image-manipulator cannot encode it,
 * so WebP is used.
 */
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, MAX_THUMB_BYTES, MAX_THUMB_SIDE, type PhotoInput } from '@triangulair/sync';

import { encodeToFit, fitSize, fromBase64, type QualitySpec } from './model';
import { PhotoPermissionError, PhotoProcessError, type Picked, type PickSource } from './pick.types';

export async function pickImage(from: PickSource): Promise<Picked | null> {
  const perm = from === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new PhotoPermissionError();
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false, base64: false, allowsEditing: false };
  const res = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = res.canceled ? null : res.assets[0];
  return a ? { uri: a.uri, width: a.width, height: a.height } : null;
}

/** Deletes a temporary file of ours (only in the app's cache folder; best effort). */
function discard(uri: string | undefined): void {
  if (!uri) return;
  try {
    if (!uri.startsWith(Paths.cache.uri)) return;
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // the OS clears the cache folder eventually
  }
}

async function encode(uri: string, w: number, h: number, side: number, quality: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const size = fitSize(w, h, side);
  const ctx = ImageManipulator.manipulate(uri);
  ctx.resize({ width: size.width, height: size.height });
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.WEBP, compress: quality, base64: true });
  discard(out.uri);
  if (!out.base64) throw new PhotoProcessError('no image data');
  return { bytes: fromBase64(out.base64), width: out.width, height: out.height };
}

export async function processImage(p: Picked, q: QualitySpec): Promise<PhotoInput> {
  try {
    const at = (side: number, quality: number) => encode(p.uri, p.width, p.height, side, quality);
    const full = await encodeToFit(at, { side: q.side, quality: q.quality, maxSide: MAX_PHOTO_SIDE, maxBytes: MAX_PHOTO_BYTES });
    const thumb = await encodeToFit(at, { side: q.thumbSide, quality: q.thumbQuality, maxSide: MAX_THUMB_SIDE, maxBytes: MAX_THUMB_BYTES });
    return { full: full.bytes, thumb: thumb.bytes, width: full.width, height: full.height };
  } catch (e) {
    if (e instanceof PhotoProcessError) throw e;
    throw new PhotoProcessError(e instanceof Error ? e.message : String(e));
  } finally {
    discard(p.uri);
  }
}
