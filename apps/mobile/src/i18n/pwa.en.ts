import type { Messages } from './core';

/** The installable web app (PWA): update prompt, storage in this browser, CORS hints. */
export const pwaEn: Messages = {
  'pwa.update': 'A new version of TrianguLair is ready.',
  'pwa.reload': 'Reload',
  'pwa.later': 'Later',
  'pwa.storage': 'Storage in this browser',
  'pwa.storage.persisted': 'Kept: this browser will not clear your places and keys to free up space.',
  'pwa.storage.notPersisted': 'Not guaranteed: this browser may clear your places and keys when space runs low or after weeks without use.',
  'pwa.storage.unknown': 'This browser does not say whether it keeps your data.',
  'pwa.storage.usage': 'Used here: {usage} of {quota} available.',
  'pwa.storage.ask': 'Ask the browser to keep my data',
  'pwa.storage.refused': 'The browser did not agree (yet). Installing the app (Add to Home Screen) usually lets it keep your data.',
  'pwa.storage.install': 'On an iPhone, open this page in Safari › Share › Add to Home Screen: an app opened from the Home Screen keeps its data; a Safari tab may lose it after 7 days without a visit.',
  'pwa.storage.kit': 'In a browser, your recovery kit matters even more than on a phone: clearing the browser’s data, or a browser that clears it for you, erases this device. Keep the kit (12 words) somewhere safe.',
  'pwa.storage.kitOpen': 'My recovery kit',
  'pwa.cors.own': 'In the web version, this can also mean that your storage does not allow this address (CORS). The phone apps do not need it.',
  'pwa.cors.friend': 'In the web version, their storage must allow this address (CORS); the phone apps do not need it.',
  'pwa.cors.guide': 'How to allow it',
};
