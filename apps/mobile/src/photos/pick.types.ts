/** What the platform pickers hand to the processing step. */
export interface Picked {
  /** A URI the platform can load (file:// on the phone, blob: or data: on the web). */
  uri: string;
  width: number;
  height: number;
  /** Web: the chosen file. */
  file?: Blob;
}

export type PickSource = 'camera' | 'library';

/** The image could not be read or encoded. */
export class PhotoProcessError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PhotoProcessError';
  }
}

/** Camera or photo library permission refused. */
export class PhotoPermissionError extends Error {
  constructor() {
    super('permission refused');
    this.name = 'PhotoPermissionError';
  }
}
