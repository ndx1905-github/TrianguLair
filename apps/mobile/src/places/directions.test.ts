import { describe, expect, it } from 'vitest';

import { defaultDirectionsUrl, directionsUrl, openInTargets, openInUrl } from './directions';

const P = { name: 'Le Baron Rouge', lat: 48.849612345, lon: 2.3782, address: '1 Rue Théophile Roussel, Paris', osmType: 'node' as const, osmId: 42 };

describe('directions and "open in" links', () => {
  it('opens the place in Apple Maps, Google Maps and OpenStreetMap', () => {
    expect(openInUrl('apple', P)).toBe('https://maps.apple.com/?q=Le%20Baron%20Rouge&ll=48.849612,2.3782');
    expect(openInUrl('google', P)).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Le Baron Rouge, 1 Rue Théophile Roussel, Paris')}`);
    expect(openInUrl('osm', P)).toBe('https://www.openstreetmap.org/node/42');
    expect(openInUrl('osm', { ...P, osmType: null, osmId: null })).toBe('https://www.openstreetmap.org/?mlat=48.849612&mlon=2.3782#map=18/48.849612/2.3782');
  });

  it('directions in each app, and the phone’s own', () => {
    expect(directionsUrl('apple', P)).toBe('https://maps.apple.com/?daddr=48.849612,2.3782&q=Le%20Baron%20Rouge');
    expect(directionsUrl('google', P)).toBe('https://www.google.com/maps/dir/?api=1&destination=48.849612,2.3782');
    expect(directionsUrl('osm', P)).toBe('https://www.openstreetmap.org/directions?to=48.849612,2.3782');
    expect(defaultDirectionsUrl('android', P)).toBe('geo:48.849612,2.3782?q=48.849612,2.3782(Le%20Baron%20Rouge)');
    expect(defaultDirectionsUrl('ios', P)).toBe(directionsUrl('apple', P));
    expect(defaultDirectionsUrl('web', P)).toBe(directionsUrl('google', P));
    expect(openInTargets('android')[0]).toBe('google');
    expect(openInTargets('ios')[0]).toBe('apple');
  });
});
