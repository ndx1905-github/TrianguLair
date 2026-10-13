import sys; sys.path.insert(0, "scripts")
from tasks import T, MILESTONES
ST = {"todo": "to do", "wip": "in progress", "review": "in review", "done": "done"}
out = ["# Tasks", "",
       "The [specification](SPEC.md) broken down into tasks. Each task is also a GitHub issue (same ID in the title).",
       "Generated from `scripts/tasks.py`: edit that file, then run `python3 scripts/gen_tasks_md.py`.", "",
       "To contribute: pick a \"to do\" task whose dependencies are done, comment on the issue to claim it, then open a PR (see [CONTRIBUTING](../CONTRIBUTING.md)).", ""]
for p, name in MILESTONES.items():
    out += [f"## {name}", "", "| ID | Task | Areas | Depends on | Status |", "|---|---|---|---|---|"]
    for x in T:
        if x["phase"] == p:
            out.append(f"| {x['id']} | {x['title']} | {', '.join(x['labels'])} | {', '.join(x['deps']) or '—'} | {ST[x['status']]} |")
    out.append("")
out += ["## Details", ""]
for x in T:
    out += [f"### {x['id']} — {x['title']}", "", x["desc"], "", "Acceptance criteria:", ""]
    out += [f"- [ ] {a}" for a in x["accept"]]
    if x["deps"]: out += ["", "Depends on: " + ", ".join(x["deps"])]
    out.append("")
open("docs/TASKS.md", "w", encoding="utf-8").write("\n".join(out))
print(len(T), "tasks")
