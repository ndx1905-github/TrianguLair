import sys; sys.path.insert(0, "scripts")
from tasks import T, MILESTONES
ST = {"todo": "à faire", "wip": "en cours", "review": "en relecture", "done": "fait"}
out = ["# Tâches", "",
       "Découpage de la [spécification](SPEC.md) en tâches. Chaque tâche existe aussi sous forme d'issue GitHub (même identifiant dans le titre).",
       "Généré depuis `scripts/tasks.py` : modifier ce fichier-là puis lancer `python3 scripts/gen_tasks_md.py`.", "",
       "Pour contribuer : choisir une tâche « à faire » dont les dépendances sont terminées, commenter l'issue pour la prendre, puis ouvrir une PR (voir [CONTRIBUTING](../CONTRIBUTING.md)).", ""]
for p, name in MILESTONES.items():
    out += [f"## {name}", "", "| ID | Tâche | Domaines | Dépend de | Statut |", "|---|---|---|---|---|"]
    for x in T:
        if x["phase"] == p:
            out.append(f"| {x['id']} | {x['title']} | {', '.join(x['labels'])} | {', '.join(x['deps']) or '—'} | {ST[x['status']]} |")
    out.append("")
out += ["## Détail", ""]
for x in T:
    out += [f"### {x['id']} — {x['title']}", "", x["desc"], "", "Critères d'acceptation :", ""]
    out += [f"- [ ] {a}" for a in x["accept"]]
    if x["deps"]: out += ["", "Dépend de : " + ", ".join(x["deps"])]
    out.append("")
open("docs/TASKS.md", "w", encoding="utf-8").write("\n".join(out))
print(len(T), "tâches")
