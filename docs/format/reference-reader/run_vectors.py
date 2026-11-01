"""Runs the reference reader against docs/format/vectors/*.json.

For every vector whose `op` this reader implements, the result ({"ok": ...} or {"error": CODE,
...details}) must equal the vector's `expect` exactly. Other ops are counted as skipped.
Exit status 0 if every supported vector matches. Usage: python3 run_vectors.py [vectors-dir]
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tlreader as tl  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, "..", "vectors")


def resolve(v: Any, fixtures: dict) -> Any:
    if isinstance(v, list):
        return [resolve(x, fixtures) for x in v]
    if isinstance(v, dict):
        if list(v.keys()) == ["$ref"]:
            return resolve(fixtures[v["$ref"]], fixtures)
        return {k: resolve(x, fixtures) for k, x in v.items()}
    return v


def unhex(h: str) -> bytes:
    return bytes.fromhex(h)


def index_args(o: dict | None) -> dict:
    o = o or {}
    now = tl.iso_ms(o["now"], "now")
    kw: dict[str, Any] = {"now": now}
    if "expectedOwner" in o:
        kw["expected_owner"] = o["expectedOwner"]
    if "retiredOwners" in o:
        kw["retired"] = o["retiredOwners"]
    if "location" in o:
        kw["location"] = o["location"]
    if "lastSeen" in o:
        kw["last_seen"] = tl.verify_index(o["lastSeen"], now=now)
    if "lastSeenAnchor" in o:
        kw["last_seen"] = tl.anchor_from_json(o["lastSeenAnchor"])
    return kw


def index_summary(idx: tl.Index) -> dict:
    d = idx.doc
    out = {
        "owner": d["owner"],
        "seq": d["seq"],
        "rotation": idx.cert["rotation"],
        "location": idx.cert["location"],
        "device": d["device_cert"]["device"],
        "revoked_devices": list(d["revoked_devices"]),
        "packs": [p["hash"] for p in d["packs"]],
        "invitations": list(d.get("invitations", [])),
    }
    if "public" in d:
        out["public"] = d["public"]["hash"]
    if "move" in d:
        out["move_from"] = d["move"]["from"]
    if "minor" in d:
        out["minor"] = d["minor"]
    return out


def cert_summary(c: dict) -> dict:
    out = {"owner": c["owner"], "key": c["key"], "rotation": c["rotation"], "revoked_devices": list(c["revoked_devices"])}
    if "location" in c:
        out["location"] = c["location"]
    return out


def keys(lst: list) -> list[tuple[bytes, bytes]]:
    return [(unhex(k["public_hex"]), unhex(k["secret_hex"])) for k in lst]


def op_verify_index(i: dict) -> dict:
    data = unhex(i["bytes_hex"]) if "bytes_hex" in i else i["text"]
    return index_summary(tl.verify_index(data, **index_args(i.get("options"))))


def op_open_pack(i: dict) -> dict:
    idx = tl.verify_index(i["index"]["text"], **index_args(i["index"].get("options")))
    p = tl.open_pack(unhex(i["bytes_hex"]), idx, keys(i["keys"]))
    return {"id": p.id, "type": p.type, "file": p.file, "payload_hex": p.payload.hex()}


def op_open_group_key(i: dict) -> dict:
    idx = tl.verify_index(i["index"]["text"], **index_args(i["index"].get("options")))
    g = tl.open_group_key(unhex(i["bytes_hex"]), idx, keys(i["keys"]))
    return {"owner": g["owner"], "group": g["group"], "generation": g["generation"], "secret_hex": g["secret"].hex(), "public_hex": g["public"].hex()}


def op_parse_link(i: dict) -> dict:
    r = tl.parse_invitation_link(i["link"], tl.iso_ms(i["now"], "now"))
    return {
        "id": r.id,
        "owner": r.owner,
        "location": r.location,
        "rotation": r.rotation,
        "expires": tl.iso_string(r.expires * 1000),
        "invitation_public_hex": r.public.hex(),
        "invitation_secret_hex": r.secret.hex(),
        "token": r.token,
    }


def op_accept(i: dict) -> dict:
    now = tl.iso_ms(i["now"], "now")
    r = tl.parse_invitation_link(i["link"], now)
    last = tl.verify_index(i["lastSeen"], now=now) if "lastSeen" in i else None
    idx = tl.verify_index(i["index"], expected_owner=r.owner, location=i.get("read_from", r.location), now=now, last_seen=last)
    tl.check_invitation_index(r, idx, now, last)
    return {"owner": r.owner, "token": r.token, "rotation": idx.rotation, "seq": idx.doc["seq"]}


def op_header(i: dict) -> dict:
    h, _, _ = tl.read_pack_header(unhex(i["bytes_hex"]))
    return {"nonce": h["nonce"], "pad": h["pad"], "wraps": len(h["wraps"])}


def op_safety(i: dict) -> dict:
    groups, qr = tl.safety(i["a"], i["b"])
    return {"groups": groups, "qr": qr}


def op_listing(i: dict) -> dict:
    k = unhex(i["vault_key_hex"])
    return {"pad_key_hex": tl.pad_key(k).hex(), "list": tl.listing(i["tokens"], k, tl.iso_ms(i["now"], "now"))}


def op_anchor(i: dict) -> dict:
    return {"anchor": tl.anchor_json(tl.verify_index(i["text"], **index_args(i.get("options"))))}


def op_signature(i: dict) -> dict:
    tl.verify_sig(i["domain"], unhex(i["signature_hex"]), unhex(i["message_hex"]), unhex(i["public_key_hex"]))
    return {}


def op_check_location(i: dict) -> dict:
    tl.check_location(i["location"])
    return {}


def op_device(i: dict) -> dict:
    o = i.get("options", {})
    c = tl.verify_device_cert(i["text"], o.get("expectedOwner"), o.get("retiredOwners", ()))
    return {"owner": c["owner"], "device": c["device"], "box": c["box"]}


def op_sharing(i: dict) -> dict:
    o = i.get("options", {})
    last = tl.verify_sharing_cert(o["lastSeen"]) if "lastSeen" in o else None
    return cert_summary(tl.verify_sharing_cert(i["text"], o.get("expectedOwner"), o.get("retiredOwners", ()), last))


def op_move(i: dict) -> dict:
    m = tl.verify_identity_move(i["text"], i.get("options", {}).get("expectedFrom"))
    return {"from": m["from"], "to": m["to"], "issued": m["issued"]}


OPS: dict[str, Callable[[dict], dict]] = {
    "canonical_json": lambda i: {"canonical": tl.canon(tl.parse_canonical(i["text"], "doc"))},
    "parse_key": lambda i: {"hex": tl.parse_key(i["kind"], i["value"]).hex()},
    "check_location": op_check_location,
    "signature": op_signature,
    "verify_sharing_cert": op_sharing,
    "verify_device_cert": op_device,
    "verify_identity_move": op_move,
    "verify_index": op_verify_index,
    "index_anchor": op_anchor,
    "listing_padding": op_listing,
    "invitation_token": lambda i: {"token": tl.invitation_token(unhex(i["owner_public_hex"]), unhex(i["invitation_public_hex"]), i["rotation"], i["expires"], i["location"])},
    "padded_length": lambda i: {"length": tl.padme(i["n"])},
    "read_pack_header": op_header,
    "open_pack": op_open_pack,
    "open_group_key": op_open_group_key,
    "parse_invitation_link": op_parse_link,
    "accept_invitation": op_accept,
    "safety_code": op_safety,
}


def run(op: str, i: dict) -> dict:
    try:
        return {"ok": OPS[op](i)}
    except tl.TLError as e:
        out: dict[str, Any] = {"error": e.code}
        if e.code == "ROLLBACK":
            out["fork"] = bool(e.details.get("fork", False))
        if e.code == "MOVED":
            out["location"] = e.details["location"]
        if e.code == "IDENTITY_MOVED":
            out.update({k: e.details[k] for k in ("from", "to", "conflict")})
        if e.code == "UNSUPPORTED_VERSION" and "critical" in e.details:
            out["critical"] = e.details["critical"]
        return out


def main() -> int:
    vdir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    passed = failed = skipped = 0
    per_op: dict[str, int] = {}
    for name in sorted(os.listdir(vdir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(vdir, name), encoding="utf-8") as f:
            file = json.load(f)
        for v in file["vectors"]:
            if v["op"] not in OPS:
                skipped += 1
                continue
            got = run(v["op"], resolve(v["input"], file["fixtures"]))
            if got == v["expect"]:
                passed += 1
                per_op[v["op"]] = per_op.get(v["op"], 0) + 1
            else:
                failed += 1
                print(f"FAIL {name} {v['name']}: expected {json.dumps(v['expect'])[:200]} got {json.dumps(got)[:200]}")
    print(f"reference reader: {passed} passed, {failed} failed, {skipped} skipped (ops not implemented)")
    for op in sorted(per_op):
        print(f"  {op}: {per_op[op]}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
