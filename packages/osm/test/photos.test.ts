import { describe, expect, it } from 'vitest';
import { CommonsClient, commonsFileFromImageTag, commonsLicense, parseCommonsRefs } from '../src/photos/commons.ts';
import { PanoramaxClient } from '../src/photos/panoramax.ts';
import { htmlToText } from '../src/photos/types.ts';
import type { OsmElement } from '../src/types.ts';
import { fakeFetch, fixture, fixtureJson, testHttp } from './support/fake.ts';

const COMMONS = 'https://commons.test/w/api.php';
const WIKIDATA = 'https://wikidata.test/w/api.php';
const museum = fixtureJson<{ elements: OsmElement[] }>('overpass/nearby-marais.json').elements.find((e) => e.id === 412345678)!;

describe('Commons references from OSM tags', () => {
  it('reads image, wikimedia_commons and wikidata', () => {
    expect(parseCommonsRefs(museum.tags!)).toEqual({
      files: ['File:Musée des Cartes Anciennes - façade.jpg'],
      categories: ['Category:Musée des Cartes Anciennes'],
      wikidata: 'Q99999901',
    });
  });

  it.each([
    ['File:Foo_bar.jpg', 'File:Foo bar.jpg'],
    ['Image:foo.jpg', 'File:Foo.jpg'],
    ['https://commons.m.wikimedia.org/wiki/File:Foo%20bar.jpg', 'File:Foo bar.jpg'],
    ['https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo_bar.jpg', 'File:Foo bar.jpg'],
    ['https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo_bar.jpg/800px-Foo_bar.jpg', 'File:Foo bar.jpg'],
  ])('image=%s → %s', (v, t) => {
    expect(commonsFileFromImageTag(v)).toBe(t);
  });

  it('ignores non-Commons images (copyrighted business photos, other hosts)', () => {
    expect(commonsFileFromImageTag('https://www.restaurant.example/photo.jpg')).toBeNull();
    expect(commonsFileFromImageTag('https://upload.wikimedia.org/wikipedia/fr/a/ab/NonFree_logo.png')).toBeNull();
    expect(parseCommonsRefs({ image: 'https://images.mapillary.com/x.jpg', wikidata: 'not-a-qid' })).toEqual({ files: [], categories: [] });
  });

  it('license and author text', () => {
    expect(commonsLicense({ LicenseShortName: { value: 'Public domain' } })).toEqual({ name: 'Public domain', attributionRequired: false });
    expect(commonsLicense({ LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: '//creativecommons.org/licenses/by/4.0' } })).toEqual({
      name: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0',
      attributionRequired: true,
    });
    expect(commonsLicense({})).toBeNull();
    expect(htmlToText('<a href="x">Paul &amp; Marie</a><br/>(&#169; 2020)')).toBe('Paul & Marie (© 2020)');
  });
});

describe('CommonsClient against recorded responses', () => {
  function client() {
    const ff = fakeFetch()
      .on((c) => c.url.startsWith(WIKIDATA), fixture('photos/wikidata-Q99999901.json'))
      .on((c) => c.url.startsWith(COMMONS) && c.url.includes('generator=categorymembers'), fixture('photos/commons-category-museum.json'))
      .on((c) => c.url.startsWith(COMMONS), fixture('photos/commons-imageinfo-museum.json'));
    return { ff, commons: new CommonsClient({ http: testHttp(ff), commonsApi: COMMONS, wikidataApi: WIKIDATA }) };
  }

  it('photosFor: explicit files first, then Wikidata P18, then the category; attribution on every photo', async () => {
    const { ff, commons } = client();
    const photos = await commons.photosFor(museum.tags!, { limit: 5 });

    expect(photos.map((p) => p.id)).toEqual([
      'File:Musée des Cartes Anciennes - façade.jpg',
      'File:Musée des Cartes Anciennes - salle 2.jpg',
      'File:Carte de Cassini exposée.jpg',
    ]);
    expect(photos[0]).toMatchObject({
      source: 'wikimedia_commons',
      author: 'Jeanne Exemple',
      license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0', attributionRequired: true },
      attribution: 'Photo: Jeanne Exemple, CC BY-SA 4.0, via Wikimedia Commons',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Mus%C3%A9e_des_Cartes_Anciennes_-_fa%C3%A7ade.jpg',
      width: 800,
      height: 600,
      capturedAt: '2024-05-18',
      streetLevel: false,
    });
    expect(photos[1]).toMatchObject({ license: { name: 'Public domain', attributionRequired: false } });
    expect(photos[2]!.attribution).toBe('Photo: Paul & Marie, CC BY 2.0, via Wikimedia Commons');
    for (const p of photos) {
      expect(p.attribution).toBeTruthy();
      expect(p.license.name).toBeTruthy();
      expect(p.pageUrl).toMatch(/^https:\/\//);
    }

    // Deprecated P18 not requested; anonymous CORS; one request per kind.
    const info = new URL(ff.calls.find((c) => c.url.includes('titles='))!.url);
    expect(info.searchParams.get('titles')).toBe('File:Musée des Cartes Anciennes - façade.jpg|File:Musée des Cartes Anciennes - salle 2.jpg');
    expect(info.searchParams.get('origin')).toBe('*');
    expect(info.searchParams.get('iiurlwidth')).toBe('800');
    expect(ff.calls).toHaveLength(3);
  });

  it('stops after explicit files when they are enough', async () => {
    const { ff, commons } = client();
    const photos = await commons.photosFor({ image: 'File:Musée des Cartes Anciennes - façade.jpg' }, { limit: 1 });
    expect(photos).toHaveLength(1);
    expect(ff.calls).toHaveLength(1);
  });

  it('no Commons tags: no request', async () => {
    const { ff, commons } = client();
    expect(await commons.photosFor({ amenity: 'cafe', image: 'https://cafe.example/p.jpg' })).toEqual([]);
    expect(ff.calls).toHaveLength(0);
  });
});

describe('PanoramaxClient against a recorded response', () => {
  it('pictures looking at the place, with license and author; unlicensed pictures dropped', async () => {
    const ff = fakeFetch().on('/search?', fixture('photos/panoramax-search.json'));
    const pmx = new PanoramaxClient({
      http: testHttp(ff),
      baseUrl: 'https://panoramax.test/api',
      viewerUrl: 'https://panoramax.test/#focus=pic&pic={id}',
    });
    const place = { lat: 48.8591004, lon: 2.3621507 };
    const photos = await pmx.picturesOf(place, { radius: 25, limit: 3 });

    const p = new URL(ff.calls[0]!.url).searchParams;
    expect(p.get('place_position')).toBe('2.362151,48.8591');
    expect(p.get('place_distance')).toBe('0-25');

    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({
      source: 'panoramax',
      id: '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      url: 'https://panoramax.example.org/api/pictures/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b/sd.jpg',
      fullUrl: 'https://panoramax.example.org/api/pictures/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b/hd.jpg',
      author: 'rue_par_rue',
      license: { name: 'CC BY-SA 4.0', attributionRequired: true },
      attribution: 'Photo: rue_par_rue, CC BY-SA 4.0, via Panoramax',
      pageUrl: 'https://panoramax.test/#focus=pic&pic=0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      heading: 251,
      streetLevel: true,
    });
    expect(photos[1]).toMatchObject({ author: 'IGN', license: { name: 'Licence Ouverte 2.0' } });
    expect(photos[0]!.distance).toBeLessThan(15);
  });
});
