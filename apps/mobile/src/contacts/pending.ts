/**
 * A link on its way to a screen (deep link, scanned QR, first launch): kept in memory, never in a
 * URL query (the invitation secret must not end up in the browser history or a server log). The
 * first launch keeps it in the secret store instead (`pending-invitation`), see PendingInvitation.
 */
export interface PendingLink {
  text: string;
  faceToFace: boolean;
}

let pending: PendingLink | null = null;

export function setPendingLink(text: string, faceToFace = false): void {
  pending = { text, faceToFace };
}

/** The link waiting for a screen, once. */
export function takePendingLink(): PendingLink | null {
  const p = pending;
  pending = null;
  return p;
}
