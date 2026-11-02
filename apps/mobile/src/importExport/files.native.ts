/**
 * Native file access for import/export: the system document picker
 * (expo-document-picker), the file read as bytes (expo-file-system, needed for
 * KMZ) and the share sheet for the export (expo-sharing: save to Files, send
 * by mail…). These are native modules: a new development build is needed.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ImportFile } from '@triangulair/import';

export async function pickImportFile(): Promise<ImportFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  const bytes = await new File(asset.uri).bytes();
  return { name: asset.name, bytes };
}

/** Writes the export to the cache and opens the share sheet. Returns how it was handed over. */
export async function saveExportFile(name: string, text: string, dialogTitle: string): Promise<'shared' | 'downloaded'> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/geo+json', UTI: 'public.json', dialogTitle });
  return 'shared';
}
