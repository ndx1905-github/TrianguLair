import type { Messages } from './core';

/** L’application web installable (PWA) : mise à jour, stockage du navigateur, aide CORS. */
export const pwaFr: Messages = {
  'pwa.update': 'Une nouvelle version de TrianguLair est prête.',
  'pwa.reload': 'Recharger',
  'pwa.later': 'Plus tard',
  'pwa.storage': 'Stockage dans ce navigateur',
  'pwa.storage.persisted': 'Conservé : ce navigateur n’effacera pas vos lieux et vos clés pour gagner de la place.',
  'pwa.storage.notPersisted': 'Non garanti : ce navigateur peut effacer vos lieux et vos clés s’il manque de place ou après des semaines sans visite.',
  'pwa.storage.unknown': 'Ce navigateur n’indique pas s’il conserve vos données.',
  'pwa.storage.usage': 'Utilisé ici : {usage} sur {quota} disponibles.',
  'pwa.storage.ask': 'Demander au navigateur de conserver mes données',
  'pwa.storage.refused': 'Le navigateur n’a pas (encore) accepté. Installer l’app (Sur l’écran d’accueil) lui permet en général de conserver vos données.',
  'pwa.storage.install': 'Sur un iPhone, ouvrez cette page dans Safari › Partager › Sur l’écran d’accueil : une app ouverte depuis l’écran d’accueil garde ses données ; un onglet Safari peut les perdre après 7 jours sans visite.',
  'pwa.storage.kit': 'Dans un navigateur, votre kit de récupération compte encore plus que sur un téléphone : effacer les données du navigateur, ou un navigateur qui les efface pour vous, vide cet appareil. Gardez le kit (12 mots) en lieu sûr.',
  'pwa.storage.kitOpen': 'Mon kit de récupération',
  'pwa.cors.own': 'Dans la version web, cela peut aussi vouloir dire que votre stockage n’autorise pas cette adresse (CORS). Les apps pour téléphone n’en ont pas besoin.',
  'pwa.cors.friend': 'Dans la version web, son stockage doit autoriser cette adresse (CORS) ; les apps pour téléphone n’en ont pas besoin.',
  'pwa.cors.guide': 'Comment l’autoriser',
};
