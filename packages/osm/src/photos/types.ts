/**
 * Free photos of a place. Every photo carries what the card must show under
 * it: author, license (with link) and a link to the source page (SPEC: Data
 * attributions and licenses). A photo without license information is never
 * returned.
 */

export interface PhotoLicense {
  /** Short name, e.g. "CC BY-SA 4.0", "Public domain", "Licence Ouverte 2.0". */
  name: string;
  url?: string;
  /** False for public domain / CC0. */
  attributionRequired: boolean;
}

export interface Photo {
  source: 'wikimedia_commons' | 'panoramax';
  /** Commons file title ("File:…") or Panoramax picture id. */
  id: string;
  /** Image to display (Commons thumbnail at the requested width, Panoramax SD). */
  url: string;
  /** Full-size / HD image. */
  fullUrl: string;
  /** Small thumbnail for lists. */
  thumbnailUrl: string;
  width?: number;
  height?: number;
  /** Page of the photo at its source (author, license, history). */
  pageUrl: string;
  /** Plain-text author (HTML stripped). */
  author?: string;
  license: PhotoLicense;
  /** Ready-to-display credit line, e.g. "Photo: Jane Doe, CC BY-SA 4.0, via Wikimedia Commons". */
  attribution: string;
  /** ISO date the photo was taken, when known. */
  capturedAt?: string;
  /** Panoramax: meters from the place, and the camera heading in degrees. */
  distance?: number;
  heading?: number;
  /** Street-level picture (façade view) rather than a photo of the place. */
  streetLevel: boolean;
}

export function attributionLine(p: { author?: string; license: PhotoLicense }, via: string): string {
  const parts = [p.author ? `Photo: ${p.author}` : 'Photo', p.license.name, `via ${via}`];
  return parts.join(', ');
}

/** Strips HTML (Commons `Artist` is HTML) and decodes the common entities. */
export function htmlToText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}
