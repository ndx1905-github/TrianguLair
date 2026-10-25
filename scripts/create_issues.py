"""Sync GitHub labels, milestones and issues from scripts/tasks.py.
Creates missing issues and updates existing ones (matched by the T-xxx ID at the start of the title).
Usage: GH_REPO=owner/repo python3 scripts/create_issues.py   (requires an authenticated gh)"""
import json, os, subprocess, sys
sys.path.insert(0, "scripts")
from tasks import T, MILESTONES, checkbox

REPO = os.environ.get("GH_REPO", "ndx1905-github/TrianguLair")
COLORS = {"crypto":"b60205","storage":"0e8a16","sync":"1d76db","app":"5319e7","map":"0052cc","osm":"7cb342",
          "data":"006b75","design":"d876e3","infra":"666666","legal":"fbca04","import":"c2e0c6","maintainer":"f9d0c4",
          "review":"e99695","i18n":"bfdadc","sharing":"0e8a16","tests":"c5def5","release":"fef2c0","docs":"0075ca",
          "in progress":"ededed","in review":"ededed"}
RENAMED_LABELS = {"humain": "maintainer", "en cours": "in progress", "en relecture": "in review"}
STATUS_LABEL = {"wip": "in progress", "review": "in review"}

def gh(*args, input=None):
    r = subprocess.run(["gh", "api", *args], input=input, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr)
    return json.loads(r.stdout or "null")

def call(method, path, payload):
    return gh("-X", method, path, "--input", "-", input=json.dumps(payload))

# Labels
labels = {l["name"] for l in gh(f"repos/{REPO}/labels?per_page=100", "--paginate")}
for old, new in RENAMED_LABELS.items():
    if old in labels and new not in labels:
        call("PATCH", f"repos/{REPO}/labels/{old.replace(' ', '%20')}", {"new_name": new})
        labels = (labels - {old}) | {new}
for name, color in COLORS.items():
    if name not in labels:
        call("POST", f"repos/{REPO}/labels", {"name": name, "color": color})

# Milestones (matched by "Phase N" prefix so titles can be renamed)
ms = {m["title"].split(" ")[1]: m for m in gh(f"repos/{REPO}/milestones?state=all&per_page=100", "--paginate")
      if m["title"].startswith("Phase ")}
num_ms = {}
for key, title in MILESTONES.items():
    n = key[1]
    if n in ms:
        if ms[n]["title"] != title:
            call("PATCH", f"repos/{REPO}/milestones/{ms[n]['number']}", {"title": title})
        num_ms[key] = ms[n]["number"]
    else:
        num_ms[key] = call("POST", f"repos/{REPO}/milestones", {"title": title})["number"]

# Issues
existing = {i["title"].split(" ")[0]: i["number"]
            for i in gh(f"repos/{REPO}/issues?state=all&per_page=100", "--paginate") if "pull_request" not in i}
num = dict(existing)
def body_of(x):
    deps = ", ".join(f"{d} (#{num[d]})" if d in num else d for d in x["deps"]) or "—"
    return (f"{x['desc']}\n\n**Acceptance criteria**\n\n" + "\n".join(checkbox(a) for a in x["accept"]) +
            f"\n\n**Depends on**: {deps}\n\nSpec: [docs/SPEC.md](../blob/main/docs/SPEC.md) · Tasks: [docs/TASKS.md](../blob/main/docs/TASKS.md)")
for x in T:  # create missing first so dependency links resolve
    if x["id"] not in num:
        num[x["id"]] = call("POST", f"repos/{REPO}/issues", {"title": f"{x['id']} — {x['title']}"})["number"]
        print("created", x["id"], "#", num[x["id"]])
for x in T:
    payload = {"title": f"{x['id']} — {x['title']}", "body": body_of(x),
               "labels": x["labels"] + ([STATUS_LABEL[x["status"]]] if x["status"] in STATUS_LABEL else []),
               "milestone": num_ms[x["phase"]]}
    if x["status"] == "done": payload["state"] = "closed"
    call("PATCH", f"repos/{REPO}/issues/{num[x['id']]}", payload)
print("synced", len(T), "issues")
