# Contribuer à TrianguLair

Merci de votre intérêt ! Le projet est en phase 0 ; les contributions sont sur invitation pour l'instant.

## Par où commencer

1. Lire la [spécification](docs/SPEC.md) : c'est la source de vérité.
2. Choisir une tâche dans [docs/TASKS.md](docs/TASKS.md) ou dans les issues (`T-xxx` dans le titre), avec le statut « à faire » et des dépendances terminées.
3. Commenter l'issue pour la prendre, afin d'éviter le travail en double.

## Règles

- **Une branche par tâche**, nommée `t-xxx-description-courte`, et une pull request qui référence l'issue (`Closes #n`).
- **Les tests sont le contrat** : une PR n'est fusionnée que si ses tests et ceux du projet passent (`npm test`, `npm run typecheck`).
- **Parties sensibles** (chiffrement, synchronisation, clés) : relecture obligatoire par quelqu'un qui n'a pas écrit le code.
- **La spec d'abord** : un changement de comportement ou de format passe par une PR sur `docs/SPEC.md`, discutée avant d'être codée.
- **TypeScript strict**, pas de dépendance à un service propriétaire.

## Attestation d'origine (DCO)

Chaque commit doit être signé avec `git commit -s`, ce qui ajoute :

    Signed-off-by: Prénom Nom <email>

Vous attestez ainsi avoir le droit de soumettre ce code sous la licence du projet ([Developer Certificate of Origin 1.1](https://developercertificate.org/)). Aucun accord de cession n'est demandé.

## Licence

Code sous [MPL-2.0](LICENSE). Icônes et visuels : CC0 ou licence compatible.

## Conduite

Voir le [code de conduite](CODE_OF_CONDUCT.md). Failles de sécurité : voir [SECURITY.md](SECURITY.md), jamais dans une issue publique.
