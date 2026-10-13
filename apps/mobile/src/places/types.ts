import type { TagId } from '../theme/tags';

export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Ordered: the first tag is the "primary" one (icon + top band). */
  tags: TagId[];
  /** false = only known through friends' shared lists (drawn faded). */
  ownerIsMe: boolean;
}
