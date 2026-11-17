import type { Messages } from './core';

/** Corbeille, « Supprimer tout mon contenu », blocage et signalement, attribution de la carte (français). */
export const privacyFr: Messages = {
  'map.attribution': 'OpenFreeMap © OpenMapTiles, données © les contributeurs d’OpenStreetMap',
  'map.reportError': 'Signaler une erreur',

  'myContent.title': 'Mon contenu',
  'myContent.db.sqlcipher': 'Vos lieux sont chiffrés sur cet appareil, avec une clé gardée dans le coffre-fort sécurisé du téléphone.',
  'myContent.db.unavailable': 'Cette version ne peut pas chiffrer vos lieux sur cet appareil (SQLCipher manque).',
  'myContent.db.web-test': 'Version web de test : vos lieux ne sont pas chiffrés sur cet appareil. Ne l’utilisez pas pour vos vrais lieux.',

  // Corbeille.
  'trash.title': 'Corbeille',
  'trash.settingsHelp': {
    zero: 'Les lieux, zones, étiquettes et listes supprimés restent 30 jours dans la corbeille, sur tous vos appareils. La corbeille est vide.',
    one: 'Les lieux, zones, étiquettes et listes supprimés restent 30 jours dans la corbeille, sur tous vos appareils. {count} élément dans la corbeille.',
    other: 'Les lieux, zones, étiquettes et listes supprimés restent 30 jours dans la corbeille, sur tous vos appareils. {count} éléments dans la corbeille.',
  },
  'trash.help': 'Ce que vous supprimez reste ici 30 jours, sur tous vos appareils, puis part définitivement. Vos amis ne le voient plus.',
  'trash.empty': 'La corbeille est vide.',
  'trash.unnamed': 'Sans nom',
  'trash.kind.place': 'Lieu',
  'trash.kind.zone': 'Zone',
  'trash.kind.tag': 'Étiquette',
  'trash.kind.list': 'Liste',
  'trash.deletedOn': 'Supprimé le {date}',
  'trash.daysLeft': { one: 'Supprimé définitivement dans {count} jour', other: 'Supprimé définitivement dans {count} jours' },
  'trash.purgedSoon': 'Supprimé définitivement au prochain lancement',
  'trash.restore': 'Restaurer',
  'trash.restoreA11y': 'Restaurer {name}',
  'trash.deleteForever': 'Supprimer définitivement',
  'trash.deleteA11y': 'Supprimer {name} définitivement',
  'trash.deleteConfirm': 'Supprimer « {name} » définitivement ?',
  'trash.deleteHelp': 'Impossible de le restaurer ensuite, sur aucun de vos appareils.',
  'trash.restored': '« {name} » est de retour.',
  'trash.deleted': '« {name} » a été supprimé définitivement.',
  'trash.emptyAll': 'Vider la corbeille',
  'trash.emptyConfirm': { one: 'Supprimer {count} élément définitivement ?', other: 'Supprimer {count} éléments définitivement ?' },
  'trash.emptyGo': 'Vider la corbeille',
  'trash.emptied': { one: '{count} élément supprimé définitivement.', other: '{count} éléments supprimés définitivement.' },
};
