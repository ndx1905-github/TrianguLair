import type { Place } from './types';

/** Phase-0 sample data around Paris. Coordinates are approximate. */
export const MOCK_PLACES: Place[] = [
  { id: 'p01', name: 'Du Pain et des Idées', lat: 48.8713, lon: 2.3633, tags: ['bakery', 'cafe'], ownerIsMe: true },
  { id: 'p02', name: 'Le Comptoir du Relais', lat: 48.8519, lon: 2.3388, tags: ['restaurant'], ownerIsMe: true },
  { id: 'p03', name: 'Musée d’Orsay', lat: 48.86, lon: 2.3266, tags: ['museum'], ownerIsMe: true },
  { id: 'p04', name: 'Jardin du Luxembourg', lat: 48.8462, lon: 2.3372, tags: ['park', 'view'], ownerIsMe: true },
  { id: 'p05', name: 'Sacré-Cœur steps', lat: 48.8867, lon: 2.3431, tags: ['view'], ownerIsMe: true },
  { id: 'p06', name: 'Le Baron Rouge', lat: 48.8496, lon: 2.3782, tags: ['bar', 'restaurant'], ownerIsMe: true },
  { id: 'p07', name: 'Shakespeare and Company', lat: 48.8526, lon: 2.3471, tags: ['shop', 'cafe', 'museum'], ownerIsMe: true },
  { id: 'p08', name: 'New Morning', lat: 48.8723, lon: 2.3532, tags: ['music', 'bar'], ownerIsMe: true },
  { id: 'p09', name: 'Parc des Buttes-Chaumont', lat: 48.8809, lon: 2.3828, tags: ['park'], ownerIsMe: false },
  { id: 'p10', name: 'Le Perchoir', lat: 48.8612, lon: 2.3811, tags: ['bar', 'view'], ownerIsMe: false },
  { id: 'p11', name: 'Musée Rodin', lat: 48.8553, lon: 2.3158, tags: ['museum', 'park'], ownerIsMe: false },
  { id: 'p12', name: 'Marché des Enfants Rouges', lat: 48.8628, lon: 2.3618, tags: ['restaurant', 'shop'], ownerIsMe: true },
  { id: 'p13', name: 'Hôtel Grand Amour', lat: 48.8746, lon: 2.3597, tags: ['hotel', 'bar', 'restaurant', 'cafe'], ownerIsMe: false },
  { id: 'p14', name: 'Café de Flore', lat: 48.8541, lon: 2.3326, tags: ['cafe'], ownerIsMe: false },
  { id: 'p15', name: 'Philharmonie de Paris', lat: 48.8918, lon: 2.3939, tags: ['music', 'view'], ownerIsMe: true },
];
