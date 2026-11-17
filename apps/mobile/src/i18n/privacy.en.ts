import type { Messages } from './core';

/** Trash, "Delete all my content", blocking and reporting, map attribution (English). */
export const privacyEn: Messages = {
  'map.attribution': 'OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors',
  'map.reportError': 'Report an error',

  'myContent.title': 'My content',
  'myContent.db.sqlcipher': 'Your places on this device are encrypted, with a key kept in the phone’s secure vault.',
  'myContent.db.unavailable': 'This build cannot encrypt your places on this device (SQLCipher is missing).',
  'myContent.db.web-test': 'Web test build: your places on this device are not encrypted. Don’t use it for your real places.',

  // Trash (spec "Editing and deleting").
  'trash.title': 'Trash',
  'trash.settingsHelp': {
    zero: 'Deleted places, zones, tags and lists stay 30 days in the trash, on all your devices. The trash is empty.',
    one: 'Deleted places, zones, tags and lists stay 30 days in the trash, on all your devices. {count} item in the trash.',
    other: 'Deleted places, zones, tags and lists stay 30 days in the trash, on all your devices. {count} items in the trash.',
  },
  'trash.help': 'What you delete stays here for 30 days, on all your devices, then leaves for good. Your friends no longer see it.',
  'trash.empty': 'The trash is empty.',
  'trash.unnamed': 'Without a name',
  'trash.kind.place': 'Place',
  'trash.kind.zone': 'Zone',
  'trash.kind.tag': 'Tag',
  'trash.kind.list': 'List',
  'trash.deletedOn': 'Deleted on {date}',
  'trash.daysLeft': { one: 'Deleted for good in {count} day', other: 'Deleted for good in {count} days' },
  'trash.purgedSoon': 'Deleted for good at the next launch',
  'trash.restore': 'Restore',
  'trash.restoreA11y': 'Restore {name}',
  'trash.deleteForever': 'Delete forever',
  'trash.deleteA11y': 'Delete {name} forever',
  'trash.deleteConfirm': 'Delete “{name}” forever?',
  'trash.deleteHelp': 'It cannot be restored afterwards, on any of your devices.',
  'trash.restored': '“{name}” is back.',
  'trash.deleted': '“{name}” was deleted for good.',
  'trash.emptyAll': 'Empty the trash',
  'trash.emptyConfirm': { one: 'Delete {count} item forever?', other: 'Delete {count} items forever?' },
  'trash.emptyGo': 'Empty the trash',
  'trash.emptied': { one: '{count} item deleted for good.', other: '{count} items deleted for good.' },
};
