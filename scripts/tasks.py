"""Source unique du découpage en tâches. Génère docs/TASKS.md et sert à créer
les issues GitHub (scripts/create_issues.py)."""

SPEC = "docs/SPEC.md"

MILESTONES = {
    "P0": "Phase 0 — cadrage et prototypes",
    "P1": "Phase 1 — app locale",
    "P2": "Phase 2 — partage",
    "P3": "Phase 3 — ouverture",
}

# (id, phase, titre, labels, description, critères d'acceptation, dépendances, statut)
# statut : todo | wip | review | done
T = []
def t(id, phase, title, labels, desc, accept, deps=(), status="todo"):
    T.append(dict(id=id, phase=phase, title=title, labels=list(labels), desc=desc,
                  accept=list(accept), deps=list(deps), status=status))

# ---------------- Phase 0 ----------------
t("T-001","P0","Prototype du format chiffré (packages/crypto)",["crypto"],
  "Identité depuis 12 mots, clé maîtresse Ed25519 et clé de partage X25519 remplaçable, paquets XChaCha20-Poly1305, enveloppes anonymes par destinataire, groupes, index signé, invitation 7 jours et lien retour, code de transfert Argon2id, révocation. Voir « Architecture › Partage chiffré » et « Versions du format ».",
  ["`npm test` et `npm run typecheck` passent","README du format (octets, JSON, algorithmes) et THREATS.md présents"],status="review")
t("T-002","P0","Relecture indépendante du prototype de chiffrement",["crypto","review"],
  "Relecture par un agent ou une personne qui n'a pas écrit T-001 : choix des primitives, anonymat des enveloppes, sérialisation canonique, anti-retour arrière, invitation, code de transfert. Trancher les 5 questions ouvertes listées dans le rapport de T-001 (champ `seq`, sens de `etag`, identifiant de paquet stable, taille du lien d'invitation, vérification hors bande du lien retour).",
  ["Rapport de relecture dans docs/reviews/","Questions ouvertes tranchées et reportées dans la spec"],deps=["T-001"])
t("T-003","P0","Prototype des adaptateurs de stockage (packages/storage)",["storage"],
  "Interface commune get/put/delete/list/head avec écritures conditionnelles (ETag), erreurs typées ; adaptateurs WebDAV, S3, HTTPS lecture seule, SFTP (Node seulement) ; adaptateur mémoire ; suite de conformité commune ; publishSnapshot/fetchSnapshot. Voir « Protocoles de stockage » et « Organisation sur le stockage ».",
  ["Suite de conformité verte sur chaque adaptateur contre un serveur local","README par protocole (CORS, lecture publique, sémantique ETag)"],status="wip")
t("T-004","P0","Squelette de l'app Expo avec carte et épingles (apps/mobile)",["app","map"],
  "Expo + expo-router, MapLibre natif / MapLibre GL JS web derrière une interface commune, style OpenFreeMap Positron configurable, épingles SVG (icône blanche à halo fort, bandes multi-tags, épingles des amis estompées), fiche en bas d'écran, barre de filtres repliable, mode sombre. Voir « Interface » et « Fond de carte ».",
  ["`tsc --noEmit` passe, export web réussi","Capture d'écran web dans apps/mobile/docs/","eas.json prêt pour un build de développement"],status="wip")
t("T-005","P0","Maquettes des écrans principaux",["design"],
  "Carte, liste, ajout de lieu, fiche lieu, filtres, liste de partage, invitation, premier lancement, réglages de stockage. Respecter palette, épingles et feuille de style des icônes (grille 24 px, trait 2 px).",
  ["Maquettes publiées et liées depuis la spec"])
t("T-006","P0","Intégration continue GitHub Actions",["infra"],
  "Workflow lint + typecheck + tests de tous les espaces de travail à chaque PR ; export web ; Dependabot ; permissions en lecture seule par défaut.",
  ["Badge CI vert sur main","PR bloquée si les tests échouent"])
t("T-007","P0","Déploiement automatique de la version web de test",["infra","app"],
  "Déployer l'export web sur un hébergement statique à chaque merge (GitHub Pages ou équivalent), avec un stockage WebDAV de test configuré pour CORS.",
  ["Lien de test publié dans le README"],deps=["T-004","T-006"])
t("T-008","P0","Vérifications administratives et juridiques",["legal","humain"],
  "Déclaration du moyen de cryptologie à l'ANSSI (procédure à jour) ; impact de l'ODbL sur les listes publiques ; domaines triangulair / triangulaire ; marques TMview classes 9 et 42.",
  ["Résultats reportés dans « Légal et publication »"])
t("T-009","P0","Formats d'export Mapstr et Pin Drop",["import","humain"],
  "Obtenir un export réel depuis un compte Mapstr et Pin Drop, documenter colonnes et formats, anonymiser un échantillon pour les tests.",
  ["Échantillons dans packages/import/fixtures/","Colonnes documentées dans la spec"])
t("T-010","P0","Miroir Forgejo du dépôt",["infra","humain"],
  "Miroir automatique depuis GitHub vers la forge Forgejo du porteur, avec jeton en lecture seule.",
  ["Miroir à jour après chaque push"])

# ---------------- Phase 1 ----------------
t("T-101","P1","Base locale SQLite avec index spatial",["data"],
  "Schéma du « Modèle de données » (people, groups, places, saves, tags, save_tags, tag_mappings, lists, list_items, access, media), migrations, requêtes « lieux dans cette zone ».",
  ["Tests sur 10 000 lieux sous les cibles de performance"])
t("T-102","P1","Modèle Automerge et fusion entre appareils",["sync","data"],
  "Documents CRDT pour lieux, tags, listes ; projection vers SQLite ; tests par propriétés de la fusion.",
  ["Deux appareils simulés convergent après modifications concurrentes"],deps=["T-101"])
t("T-103","P1","Carte : regroupement au dézoom et affichage filtré",["map"],
  "Clusters, épingles filtrées en couleur / autres grisées plus petites, zones affichées, performance 10 000 lieux.",
  ["60 i/s sur l'appareil de référence"],deps=["T-004","T-101"])
t("T-104","P1","Vue liste : tri, recherche texte",["app"],
  "Tri récent / distance / nom, recherche plein texte, mention « N amis ».",["Tests unitaires du tri et de la recherche"],deps=["T-101"])
t("T-105","P1","Ajout d'un lieu : lieux proches, recherche, appui long",["app","osm"],
  "Écran d'ajout listant les lieux OSM autour par distance croissante, recherche Photon/Nominatim, appui long, position actuelle ; indication « déjà chez moi / chez des amis ».",
  ["Parcours de bout en bout sur simulateur"],deps=["T-106","T-101"])
t("T-106","P1","Client OSM : Overpass, Photon/Nominatim",["osm"],
  "Clients avec cache, limites de débit respectées, User-Agent identifié, URL configurables.",["Tests avec réponses enregistrées"])
t("T-107","P1","Fiche lieu enrichie : infos, horaires, photos libres",["osm","app"],
  "Horaires (opening_hours), cuisine, régimes, terrasse, prix d'entrée ; photos Wikimedia Commons et Panoramax avec attribution.",
  ["Attribution affichée pour chaque photo"],deps=["T-106"])
t("T-108","P1","Tags personnels, couleurs, icônes, sous-tags",["app","design"],
  "Création et édition de tags, palette, icônes CC0, sous-tags « Resto › Pizza ».",["Tests de la palette et du rendu des bandes"],deps=["T-101"])
t("T-109","P1","Barre de filtres complète",["app","osm"],
  "Catégories, sous-filtres, critères OSM (ouvert maintenant, happy hour, terrasse, régime, réservation, entrée gratuite, prix), statut, visibilité, prix, texte ; repliable, état mémorisé.",
  ["Tests unitaires de chaque critère"],deps=["T-107","T-108"])
t("T-110","P1","Zones : quartiers, bouts de rue, dessin libre",["map","app"],
  "Quartier OSM existant, un ou plusieurs bouts de rue, dessin par points ou peinture au doigt ; icône de zone.",["Zones stockées en GeoJSON valide"],deps=["T-103"])
t("T-111","P1","Commentaires, statut, prix, photos perso",["app"],
  "Visibilité du commentaire (privé / amis / public), statut à tester / testé / favori, €–€€€€, photos perso.",["Visibilité respectée dans les exports"],deps=["T-101"])
t("T-112","P1","Listes par filtre enregistré ou sélection manuelle",["app"],
  "Listes dynamiques (catégories, tags, zones par nom via limites OSM ou détourées) et manuelles ; un lieu privé n'entre jamais dans une liste.",["Tests par propriétés sur l'exclusion des lieux privés"],deps=["T-109","T-110"])
t("T-113","P1","Détection mensuelle des lieux fermés",["osm"],
  "Vérification mensuelle via OSM (disused:, shop=vacant, suppression), signalement à l'utilisateur.",["Tests avec cas OSM enregistrés"],deps=["T-106"])
t("T-114","P1","Import Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON",["import"],
  "Analyse, rapprochement avec les lieux OSM, aperçu avant import, dédoublonnage.",["Échantillons de T-009 importés sans perte"],deps=["T-009","T-106"])
t("T-115","P1","Export GeoJSON complet",["import"],"Export de tous ses lieux, zones, tags, commentaires.",["Réimport sans perte"],deps=["T-101"])
t("T-116","P1","Itinéraire et ouverture dans Plans / Google Maps",["app"],"Liens profonds vers les apps de navigation.",["Testé sur iOS et Android"])
t("T-117","P1","Adaptation aux écrans : pliables, iPad, Mac, tailles de police",["app","design"],
  "Mise en page adaptative, double écran (Galaxy Fold, iPhone Duo), iPad, Mac Apple Silicon, police dynamique, zoom d'affichage iOS.",["Captures automatiques par format"])
t("T-118","P1","Langues et mode sombre",["app","i18n"],"i18n français et anglais, Weblate ; mode sombre complet.",["Aucune chaîne en dur"])
t("T-119","P1","Tests de bout en bout sur simulateurs",["infra","tests"],"Maestro ou Detox : premier lancement, ajout, filtre, liste, import.",["Exécutés en CI"],deps=["T-006"])

# ---------------- Phase 2 ----------------
t("T-201","P2","Format chiffré v1 définitif et vecteurs de test",["crypto"],
  "Figer le format après T-002, publier la spécification dans docs/format/ et des vecteurs de test.",["Vecteurs relus par une seconde implémentation"],deps=["T-002"])
t("T-202","P2","Adaptateurs de stockage en production et tests contre vrais serveurs",["storage"],
  "Nextcloud, MinIO, SFTP, serveur web en CI ; pannes simulées (délai, quota, identifiants, écriture interrompue). SFTP sur mobile : module natif ou non supporté.",["Suite de conformité verte contre chaque serveur"],deps=["T-003"])
t("T-203","P2","Réglages de stockage et migration entre stockages",["app","storage"],
  "Choix local seul / WebDAV / S3 / SFTP, adresse HTTPS de lecture, test de connexion, recopie complète lors d'un changement.",["Migration sans perte testée"],deps=["T-202"])
t("T-204","P2","Synchronisation : publication et lecture des paquets",["sync"],
  "Pendant l'usage et juste après la fermeture, sans tâche périodique ; ETag, index signé, cache des amis.",["Simulation multi-utilisateurs sans interface"],deps=["T-102","T-201","T-202"])
t("T-205","P2","Kit de récupération et premier lancement",["crypto","app"],
  "Trois entrées, phrase de 12 mots, kit de récupération, parcours standard.",["Parcours de bout en bout"],deps=["T-201"])
t("T-206","P2","Ajout d'un appareil (code de transfert, QR)",["crypto","app"],"Code Argon2id et QR code.",["Deux appareils synchronisés"],deps=["T-205","T-204"])
t("T-207","P2","Perte et vol : rotation de clé, effacement à distance",["crypto","sync"],
  "Rotation de la clé de partage, rechiffrement, suppression de la clé à la synchro sur l'appareil retiré.",["Scénario « appareil volé » simulé"],deps=["T-206"])
t("T-208","P2","Invitation par lien, QR code et lien retour",["crypto","app"],
  "Clé d'invitation temporaire 7 jours, contenu visible immédiatement, lien retour, relations asymétriques.",["Scénario complet entre deux utilisateurs simulés"],deps=["T-204"])
t("T-209","P2","Gestion des accès et révocation",["crypto","sync"],
  "Choisir ce que chaque ami peut ouvrir ; retirer un accès retire le contenu du cache de l'ami.",["Tests de révocation de bout en bout"],deps=["T-208"])
t("T-210","P2","Lieux des amis, compteurs et vue Nouveautés",["app","sync"],
  "Filtres « Aussi chez mes amis », choix des amis affichés, tags inconnus gardant la couleur d'origine, vue Nouveautés.",["Tests de la correspondance des tags"],deps=["T-204"])
t("T-211","P2","Listes publiques (GeoJSON) et lien « Voir sur uMap »",["sharing"],
  "Publication en clair de public/listes.geojson, attribution ODbL, lien uMap.",["Liste ouverte dans uMap"],deps=["T-112","T-204"])
t("T-212","P2","Listes par lien (clé dans le fragment)",["sharing","crypto"],"Suivre une liste sans suivre la personne.",["Lien ouvert sur un second appareil"],deps=["T-211"])
t("T-213","P2","Cas d'erreur de la spec",["app","sync"],"Implémenter chaque ligne du tableau « Cas d'erreur ».",["Un test par ligne"],deps=["T-204"])
t("T-214","P2","Audit de sécurité externe",["crypto","humain"],"Audit du chiffrement et de la synchronisation avant publication.",["Rapport publié et corrections faites"],deps=["T-209"])

# ---------------- Phase 3 ----------------
t("T-301","P3","Publication App Store, Play Store, F-Droid",["release","humain"],"Fiches, captures, builds reproductibles F-Droid.",["Apps publiées"],deps=["T-214"])
t("T-302","P3","Documentation utilisateur et auto-hébergement",["docs"],"Guides Nextcloud, NAS, S3, tuiles auto-hébergées.",["Guides relus par un non-technicien"])
t("T-303","P3","Guide de contribution, code de conduite, politique de sécurité",["docs"],"Compléter CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.",["Fichiers présents et liés depuis le README"])
t("T-304","P3","Financement : Liberapay / Open Collective, NLnet",["humain"],"Ouvrir les dons, candidater à NLnet.",["Candidature envoyée"])
