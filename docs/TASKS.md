# Tâches

Découpage de la [spécification](SPEC.md) en tâches. Chaque tâche existe aussi sous forme d'issue GitHub (même identifiant dans le titre).
Généré depuis `scripts/tasks.py` : modifier ce fichier-là puis lancer `python3 scripts/gen_tasks_md.py`.

Pour contribuer : choisir une tâche « à faire » dont les dépendances sont terminées, commenter l'issue pour la prendre, puis ouvrir une PR (voir [CONTRIBUTING](../CONTRIBUTING.md)).

## Phase 0 — cadrage et prototypes

| ID | Tâche | Domaines | Dépend de | Statut |
|---|---|---|---|---|
| T-001 | Prototype du format chiffré (packages/crypto) | crypto | — | en relecture |
| T-002 | Relecture indépendante du prototype de chiffrement | crypto, review | T-001 | à faire |
| T-003 | Prototype des adaptateurs de stockage (packages/storage) | storage | — | en cours |
| T-004 | Squelette de l'app Expo avec carte et épingles (apps/mobile) | app, map | — | en cours |
| T-005 | Maquettes des écrans principaux | design | — | à faire |
| T-006 | Intégration continue GitHub Actions | infra | — | à faire |
| T-007 | Déploiement automatique de la version web de test | infra, app | T-004, T-006 | à faire |
| T-008 | Vérifications administratives et juridiques | legal, humain | — | à faire |
| T-009 | Formats d'export Mapstr et Pin Drop | import, humain | — | à faire |
| T-010 | Miroir Forgejo du dépôt | infra, humain | — | à faire |

## Phase 1 — app locale

| ID | Tâche | Domaines | Dépend de | Statut |
|---|---|---|---|---|
| T-101 | Base locale SQLite avec index spatial | data | — | à faire |
| T-102 | Modèle Automerge et fusion entre appareils | sync, data | T-101 | à faire |
| T-103 | Carte : regroupement au dézoom et affichage filtré | map | T-004, T-101 | à faire |
| T-104 | Vue liste : tri, recherche texte | app | T-101 | à faire |
| T-105 | Ajout d'un lieu : lieux proches, recherche, appui long | app, osm | T-106, T-101 | à faire |
| T-106 | Client OSM : Overpass, Photon/Nominatim | osm | — | à faire |
| T-107 | Fiche lieu enrichie : infos, horaires, photos libres | osm, app | T-106 | à faire |
| T-108 | Tags personnels, couleurs, icônes, sous-tags | app, design | T-101 | à faire |
| T-109 | Barre de filtres complète | app, osm | T-107, T-108 | à faire |
| T-110 | Zones : quartiers, bouts de rue, dessin libre | map, app | T-103 | à faire |
| T-111 | Commentaires, statut, prix, photos perso | app | T-101 | à faire |
| T-112 | Listes par filtre enregistré ou sélection manuelle | app | T-109, T-110 | à faire |
| T-113 | Détection mensuelle des lieux fermés | osm | T-106 | à faire |
| T-114 | Import Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON | import | T-009, T-106 | à faire |
| T-115 | Export GeoJSON complet | import | T-101 | à faire |
| T-116 | Itinéraire et ouverture dans Plans / Google Maps | app | — | à faire |
| T-117 | Adaptation aux écrans : pliables, iPad, Mac, tailles de police | app, design | — | à faire |
| T-118 | Langues et mode sombre | app, i18n | — | à faire |
| T-119 | Tests de bout en bout sur simulateurs | infra, tests | T-006 | à faire |

## Phase 2 — partage

| ID | Tâche | Domaines | Dépend de | Statut |
|---|---|---|---|---|
| T-201 | Format chiffré v1 définitif et vecteurs de test | crypto | T-002 | à faire |
| T-202 | Adaptateurs de stockage en production et tests contre vrais serveurs | storage | T-003 | à faire |
| T-203 | Réglages de stockage et migration entre stockages | app, storage | T-202 | à faire |
| T-204 | Synchronisation : publication et lecture des paquets | sync | T-102, T-201, T-202 | à faire |
| T-205 | Kit de récupération et premier lancement | crypto, app | T-201 | à faire |
| T-206 | Ajout d'un appareil (code de transfert, QR) | crypto, app | T-205, T-204 | à faire |
| T-207 | Perte et vol : rotation de clé, effacement à distance | crypto, sync | T-206 | à faire |
| T-208 | Invitation par lien, QR code et lien retour | crypto, app | T-204 | à faire |
| T-209 | Gestion des accès et révocation | crypto, sync | T-208 | à faire |
| T-210 | Lieux des amis, compteurs et vue Nouveautés | app, sync | T-204 | à faire |
| T-211 | Listes publiques (GeoJSON) et lien « Voir sur uMap » | sharing | T-112, T-204 | à faire |
| T-212 | Listes par lien (clé dans le fragment) | sharing, crypto | T-211 | à faire |
| T-213 | Cas d'erreur de la spec | app, sync | T-204 | à faire |
| T-214 | Audit de sécurité externe | crypto, humain | T-209 | à faire |

## Phase 3 — ouverture

| ID | Tâche | Domaines | Dépend de | Statut |
|---|---|---|---|---|
| T-301 | Publication App Store, Play Store, F-Droid | release, humain | T-214 | à faire |
| T-302 | Documentation utilisateur et auto-hébergement | docs | — | à faire |
| T-303 | Guide de contribution, code de conduite, politique de sécurité | docs | — | à faire |
| T-304 | Financement : Liberapay / Open Collective, NLnet | humain | — | à faire |

## Détail

### T-001 — Prototype du format chiffré (packages/crypto)

Identité depuis 12 mots, clé maîtresse Ed25519 et clé de partage X25519 remplaçable, paquets XChaCha20-Poly1305, enveloppes anonymes par destinataire, groupes, index signé, invitation 7 jours et lien retour, code de transfert Argon2id, révocation. Voir « Architecture › Partage chiffré » et « Versions du format ».

Critères d'acceptation :

- [ ] `npm test` et `npm run typecheck` passent
- [ ] README du format (octets, JSON, algorithmes) et THREATS.md présents

### T-002 — Relecture indépendante du prototype de chiffrement

Relecture par un agent ou une personne qui n'a pas écrit T-001 : choix des primitives, anonymat des enveloppes, sérialisation canonique, anti-retour arrière, invitation, code de transfert. Trancher les 5 questions ouvertes listées dans le rapport de T-001 (champ `seq`, sens de `etag`, identifiant de paquet stable, taille du lien d'invitation, vérification hors bande du lien retour).

Critères d'acceptation :

- [ ] Rapport de relecture dans docs/reviews/
- [ ] Questions ouvertes tranchées et reportées dans la spec

Dépend de : T-001

### T-003 — Prototype des adaptateurs de stockage (packages/storage)

Interface commune get/put/delete/list/head avec écritures conditionnelles (ETag), erreurs typées ; adaptateurs WebDAV, S3, HTTPS lecture seule, SFTP (Node seulement) ; adaptateur mémoire ; suite de conformité commune ; publishSnapshot/fetchSnapshot. Voir « Protocoles de stockage » et « Organisation sur le stockage ».

Critères d'acceptation :

- [ ] Suite de conformité verte sur chaque adaptateur contre un serveur local
- [ ] README par protocole (CORS, lecture publique, sémantique ETag)

### T-004 — Squelette de l'app Expo avec carte et épingles (apps/mobile)

Expo + expo-router, MapLibre natif / MapLibre GL JS web derrière une interface commune, style OpenFreeMap Positron configurable, épingles SVG (icône blanche à halo fort, bandes multi-tags, épingles des amis estompées), fiche en bas d'écran, barre de filtres repliable, mode sombre. Voir « Interface » et « Fond de carte ».

Critères d'acceptation :

- [ ] `tsc --noEmit` passe, export web réussi
- [ ] Capture d'écran web dans apps/mobile/docs/
- [ ] eas.json prêt pour un build de développement

### T-005 — Maquettes des écrans principaux

Carte, liste, ajout de lieu, fiche lieu, filtres, liste de partage, invitation, premier lancement, réglages de stockage. Respecter palette, épingles et feuille de style des icônes (grille 24 px, trait 2 px).

Critères d'acceptation :

- [ ] Maquettes publiées et liées depuis la spec

### T-006 — Intégration continue GitHub Actions

Workflow lint + typecheck + tests de tous les espaces de travail à chaque PR ; export web ; Dependabot ; permissions en lecture seule par défaut.

Critères d'acceptation :

- [ ] Badge CI vert sur main
- [ ] PR bloquée si les tests échouent

### T-007 — Déploiement automatique de la version web de test

Déployer l'export web sur un hébergement statique à chaque merge (GitHub Pages ou équivalent), avec un stockage WebDAV de test configuré pour CORS.

Critères d'acceptation :

- [ ] Lien de test publié dans le README

Dépend de : T-004, T-006

### T-008 — Vérifications administratives et juridiques

Déclaration du moyen de cryptologie à l'ANSSI (procédure à jour) ; impact de l'ODbL sur les listes publiques ; domaines triangulair / triangulaire ; marques TMview classes 9 et 42.

Critères d'acceptation :

- [ ] Résultats reportés dans « Légal et publication »

### T-009 — Formats d'export Mapstr et Pin Drop

Obtenir un export réel depuis un compte Mapstr et Pin Drop, documenter colonnes et formats, anonymiser un échantillon pour les tests.

Critères d'acceptation :

- [ ] Échantillons dans packages/import/fixtures/
- [ ] Colonnes documentées dans la spec

### T-010 — Miroir Forgejo du dépôt

Miroir automatique depuis GitHub vers la forge Forgejo du porteur, avec jeton en lecture seule.

Critères d'acceptation :

- [ ] Miroir à jour après chaque push

### T-101 — Base locale SQLite avec index spatial

Schéma du « Modèle de données » (people, groups, places, saves, tags, save_tags, tag_mappings, lists, list_items, access, media), migrations, requêtes « lieux dans cette zone ».

Critères d'acceptation :

- [ ] Tests sur 10 000 lieux sous les cibles de performance

### T-102 — Modèle Automerge et fusion entre appareils

Documents CRDT pour lieux, tags, listes ; projection vers SQLite ; tests par propriétés de la fusion.

Critères d'acceptation :

- [ ] Deux appareils simulés convergent après modifications concurrentes

Dépend de : T-101

### T-103 — Carte : regroupement au dézoom et affichage filtré

Clusters, épingles filtrées en couleur / autres grisées plus petites, zones affichées, performance 10 000 lieux.

Critères d'acceptation :

- [ ] 60 i/s sur l'appareil de référence

Dépend de : T-004, T-101

### T-104 — Vue liste : tri, recherche texte

Tri récent / distance / nom, recherche plein texte, mention « N amis ».

Critères d'acceptation :

- [ ] Tests unitaires du tri et de la recherche

Dépend de : T-101

### T-105 — Ajout d'un lieu : lieux proches, recherche, appui long

Écran d'ajout listant les lieux OSM autour par distance croissante, recherche Photon/Nominatim, appui long, position actuelle ; indication « déjà chez moi / chez des amis ».

Critères d'acceptation :

- [ ] Parcours de bout en bout sur simulateur

Dépend de : T-106, T-101

### T-106 — Client OSM : Overpass, Photon/Nominatim

Clients avec cache, limites de débit respectées, User-Agent identifié, URL configurables.

Critères d'acceptation :

- [ ] Tests avec réponses enregistrées

### T-107 — Fiche lieu enrichie : infos, horaires, photos libres

Horaires (opening_hours), cuisine, régimes, terrasse, prix d'entrée ; photos Wikimedia Commons et Panoramax avec attribution.

Critères d'acceptation :

- [ ] Attribution affichée pour chaque photo

Dépend de : T-106

### T-108 — Tags personnels, couleurs, icônes, sous-tags

Création et édition de tags, palette, icônes CC0, sous-tags « Resto › Pizza ».

Critères d'acceptation :

- [ ] Tests de la palette et du rendu des bandes

Dépend de : T-101

### T-109 — Barre de filtres complète

Catégories, sous-filtres, critères OSM (ouvert maintenant, happy hour, terrasse, régime, réservation, entrée gratuite, prix), statut, visibilité, prix, texte ; repliable, état mémorisé.

Critères d'acceptation :

- [ ] Tests unitaires de chaque critère

Dépend de : T-107, T-108

### T-110 — Zones : quartiers, bouts de rue, dessin libre

Quartier OSM existant, un ou plusieurs bouts de rue, dessin par points ou peinture au doigt ; icône de zone.

Critères d'acceptation :

- [ ] Zones stockées en GeoJSON valide

Dépend de : T-103

### T-111 — Commentaires, statut, prix, photos perso

Visibilité du commentaire (privé / amis / public), statut à tester / testé / favori, €–€€€€, photos perso.

Critères d'acceptation :

- [ ] Visibilité respectée dans les exports

Dépend de : T-101

### T-112 — Listes par filtre enregistré ou sélection manuelle

Listes dynamiques (catégories, tags, zones par nom via limites OSM ou détourées) et manuelles ; un lieu privé n'entre jamais dans une liste.

Critères d'acceptation :

- [ ] Tests par propriétés sur l'exclusion des lieux privés

Dépend de : T-109, T-110

### T-113 — Détection mensuelle des lieux fermés

Vérification mensuelle via OSM (disused:, shop=vacant, suppression), signalement à l'utilisateur.

Critères d'acceptation :

- [ ] Tests avec cas OSM enregistrés

Dépend de : T-106

### T-114 — Import Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON

Analyse, rapprochement avec les lieux OSM, aperçu avant import, dédoublonnage.

Critères d'acceptation :

- [ ] Échantillons de T-009 importés sans perte

Dépend de : T-009, T-106

### T-115 — Export GeoJSON complet

Export de tous ses lieux, zones, tags, commentaires.

Critères d'acceptation :

- [ ] Réimport sans perte

Dépend de : T-101

### T-116 — Itinéraire et ouverture dans Plans / Google Maps

Liens profonds vers les apps de navigation.

Critères d'acceptation :

- [ ] Testé sur iOS et Android

### T-117 — Adaptation aux écrans : pliables, iPad, Mac, tailles de police

Mise en page adaptative, double écran (Galaxy Fold, iPhone Duo), iPad, Mac Apple Silicon, police dynamique, zoom d'affichage iOS.

Critères d'acceptation :

- [ ] Captures automatiques par format

### T-118 — Langues et mode sombre

i18n français et anglais, Weblate ; mode sombre complet.

Critères d'acceptation :

- [ ] Aucune chaîne en dur

### T-119 — Tests de bout en bout sur simulateurs

Maestro ou Detox : premier lancement, ajout, filtre, liste, import.

Critères d'acceptation :

- [ ] Exécutés en CI

Dépend de : T-006

### T-201 — Format chiffré v1 définitif et vecteurs de test

Figer le format après T-002, publier la spécification dans docs/format/ et des vecteurs de test.

Critères d'acceptation :

- [ ] Vecteurs relus par une seconde implémentation

Dépend de : T-002

### T-202 — Adaptateurs de stockage en production et tests contre vrais serveurs

Nextcloud, MinIO, SFTP, serveur web en CI ; pannes simulées (délai, quota, identifiants, écriture interrompue). SFTP sur mobile : module natif ou non supporté.

Critères d'acceptation :

- [ ] Suite de conformité verte contre chaque serveur

Dépend de : T-003

### T-203 — Réglages de stockage et migration entre stockages

Choix local seul / WebDAV / S3 / SFTP, adresse HTTPS de lecture, test de connexion, recopie complète lors d'un changement.

Critères d'acceptation :

- [ ] Migration sans perte testée

Dépend de : T-202

### T-204 — Synchronisation : publication et lecture des paquets

Pendant l'usage et juste après la fermeture, sans tâche périodique ; ETag, index signé, cache des amis.

Critères d'acceptation :

- [ ] Simulation multi-utilisateurs sans interface

Dépend de : T-102, T-201, T-202

### T-205 — Kit de récupération et premier lancement

Trois entrées, phrase de 12 mots, kit de récupération, parcours standard.

Critères d'acceptation :

- [ ] Parcours de bout en bout

Dépend de : T-201

### T-206 — Ajout d'un appareil (code de transfert, QR)

Code Argon2id et QR code.

Critères d'acceptation :

- [ ] Deux appareils synchronisés

Dépend de : T-205, T-204

### T-207 — Perte et vol : rotation de clé, effacement à distance

Rotation de la clé de partage, rechiffrement, suppression de la clé à la synchro sur l'appareil retiré.

Critères d'acceptation :

- [ ] Scénario « appareil volé » simulé

Dépend de : T-206

### T-208 — Invitation par lien, QR code et lien retour

Clé d'invitation temporaire 7 jours, contenu visible immédiatement, lien retour, relations asymétriques.

Critères d'acceptation :

- [ ] Scénario complet entre deux utilisateurs simulés

Dépend de : T-204

### T-209 — Gestion des accès et révocation

Choisir ce que chaque ami peut ouvrir ; retirer un accès retire le contenu du cache de l'ami.

Critères d'acceptation :

- [ ] Tests de révocation de bout en bout

Dépend de : T-208

### T-210 — Lieux des amis, compteurs et vue Nouveautés

Filtres « Aussi chez mes amis », choix des amis affichés, tags inconnus gardant la couleur d'origine, vue Nouveautés.

Critères d'acceptation :

- [ ] Tests de la correspondance des tags

Dépend de : T-204

### T-211 — Listes publiques (GeoJSON) et lien « Voir sur uMap »

Publication en clair de public/listes.geojson, attribution ODbL, lien uMap.

Critères d'acceptation :

- [ ] Liste ouverte dans uMap

Dépend de : T-112, T-204

### T-212 — Listes par lien (clé dans le fragment)

Suivre une liste sans suivre la personne.

Critères d'acceptation :

- [ ] Lien ouvert sur un second appareil

Dépend de : T-211

### T-213 — Cas d'erreur de la spec

Implémenter chaque ligne du tableau « Cas d'erreur ».

Critères d'acceptation :

- [ ] Un test par ligne

Dépend de : T-204

### T-214 — Audit de sécurité externe

Audit du chiffrement et de la synchronisation avant publication.

Critères d'acceptation :

- [ ] Rapport publié et corrections faites

Dépend de : T-209

### T-301 — Publication App Store, Play Store, F-Droid

Fiches, captures, builds reproductibles F-Droid.

Critères d'acceptation :

- [ ] Apps publiées

Dépend de : T-214

### T-302 — Documentation utilisateur et auto-hébergement

Guides Nextcloud, NAS, S3, tuiles auto-hébergées.

Critères d'acceptation :

- [ ] Guides relus par un non-technicien

### T-303 — Guide de contribution, code de conduite, politique de sécurité

Compléter CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.

Critères d'acceptation :

- [ ] Fichiers présents et liés depuis le README

### T-304 — Financement : Liberapay / Open Collective, NLnet

Ouvrir les dons, candidater à NLnet.

Critères d'acceptation :

- [ ] Candidature envoyée
