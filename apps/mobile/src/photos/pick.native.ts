/**
 * Phone: the camera or the photo library (expo-image-picker), then recompression with
 * expo-image-manipulator: about 1,600 px WebP and a thumbnail. Re-encoding writes no EXIF (no GPS,
 * no device model); the sync package strips and checks again before storing (`Photos.add`). The
 * original never leaves the picker's temporary file. AVIF: expo-image-manipulator cannot encode it,
 * so WebP is used.
 */
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PhotoInput } from '@triangulair/sync';

import { fitSize, fromBase64, type QualitySpec } from './model';
import { PhotoPermissionError, PhotoProcessError, type Picked, type PickSource } from './pick.types';

export async function pickImage(from: PickSource): Promise<Picked | null> {
  const perm = from === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new PhotoPermissionError();
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false, base64: false, allowsEditing: false };
  const res = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = res.canceled ? null : res.assets[0];
  return a ? { uri: a.uri, width: a.width, height: a.height } : null;
}

async function encode(uri: string, w: number, h: number, side: number, quality: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const size = fitSize(w, h, side);
  const ctx = ImageManipulator.manipulate(uri);
  ctx.resize({ width: size.width, height: size.height });
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.WEBP, compress: quality, base64: true });
  if (!out.base64) throw new PhotoProcessError('no image data');
  return { bytes: fromBase64(out.base64), width: out.width, height: out.height };
}

export async function processImage(p: Picked, q: QualitySpec): Promise<PhotoInput> {
  try {
    const full = await encode(p.uri, p.width, p.height, q.side, q.quality);
    const thumb = await encode(p.uri, p.width, p.height, q.thumbSide, q.thumbQuality);
    return { full: full.bytes, thumb: thumb.bytes, width: full.width, height: full.height };
  } catch (e) {
    if (e instanceof PhotoProcessError) throw e;
    throw new PhotoProcessError(e instanceof Error ? e.message : String(e));
  }
}
