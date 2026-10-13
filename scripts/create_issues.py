"""Crée labels, jalons et issues GitHub à partir de scripts/tasks.py.
Idempotent : une issue dont le titre commence par l'identifiant T-xxx n'est pas recréée.
Usage : GH_REPO=owner/repo python3 scripts/create_issues.py   (nécessite gh authentifié)"""
import json, os, subprocess, sys
sys.path.insert(0, "scripts")
from tasks import T, MILESTONES

REPO = os.environ.get("GH_REPO", "ndx1905-github/TrianguLair")
COLORS = {"crypto":"b60205","storage":"0e8a16","sync":"1d76db","app":"5319e7","map":"0052cc","osm":"7cb342",
          "data":"006b75","design":"d876e3","infra":"666666","legal":"fbca04","import":"c2e0c6","humain":"f9d0c4",
          "review":"e99695","i18n":"bfdadc","sharing":"0e8a16","tests":"c5def5","release":"fef2c0","docs":"0075ca",
          "en cours":"ededed","en relecture":"ededed"}

def gh(*args, input=None):
    r = subprocess.run(["gh", "api", *args], input=input, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr)
    return json.loads(r.stdout or "null")

labels = {l["name"] for l in gh(f"repos/{REPO}/labels", "--paginate")}
for name, color in COLORS.items():
    if name not in labels:
        gh(f"repos/{REPO}/labels", "-f", f"name={name}", "-f", f"color={color}")

ms = {m["title"]: m["number"] for m in gh(f"repos/{REPO}/milestones?state=all", "--paginate")}
for title in MILESTONES.values():
    if title not in ms:
        ms[title] = gh(f"repos/{REPO}/milestones", "-f", f"title={title}")["number"]

existing = {i["title"].split(" ")[0]: i["number"]
            for i in gh(f"repos/{REPO}/issues?state=all&per_page=100", "--paginate") if "pull_request" not in i}
num = dict(existing)
for x in T:
    if x["id"] in existing: continue
    deps = ", ".join(f"{d} (#{num[d]})" if d in num else d for d in x["deps"]) or "—"
    body = (f"{x['desc']}\n\n**Critères d'acceptation**\n\n" + "\n".join(f"- [ ] {a}" for a in x["accept"]) +
            f"\n\n**Dépend de** : {deps}\n\nSpec : [docs/SPEC.md](../blob/main/docs/SPEC.md) · Tâches : [docs/TASKS.md](../blob/main/docs/TASKS.md)")
    lab = x["labels"] + ({"wip": ["en cours"], "review": ["en relecture"]}.get(x["status"], []))
    payload = json.dumps({"title": f"{x['id']} — {x['title']}", "body": body, "labels": lab,
                          "milestone": ms[MILESTONES[x["phase"]]]})
    num[x["id"]] = gh(f"repos/{REPO}/issues", "--input", "-", input=payload)["number"]
    print("créée", x["id"], "#", num[x["id"]])
