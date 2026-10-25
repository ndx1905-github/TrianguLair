"""Minimal, independent reader of the TrianguLair format v4, written from docs/format/ only.

Covers: canonical JSON (README §4), base64url and keys (§3), signatures (§5), versioning (§6),
read addresses (identity-and-keys.md §5), sharing and device certificates, identity moves,
the signed index with ordering and anchors (signed-index.md), the invitation listing padding,
packs and Padmé (pack.md), group keys, invitation links, tokens and their acceptance
(invitation-link.md), and the safety code. It does not write anything.

Dependencies: Python >= 3.10, PyNaCl (libsodium) for Ed25519, X25519, sealed boxes and
XChaCha20-Poly1305; hashlib for BLAKE2b.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
from dataclasses import dataclass, field
from typing import Any, Iterable

from nacl import bindings as sodium
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

# --------------------------------------------------------------------------------------------
# Errors (README §7)
# --------------------------------------------------------------------------------------------


class TLError(Exception):
    def __init__(self, code: str, message: str = "", **details: Any) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.details = details


def fail(code: str, message: str = "", **details: Any) -> TLError:
    return TLError(code, message, **details)


MAX_SAFE = 2**53 - 1
HOUR_MS = 3600 * 1000
DAY_MS = 24 * HOUR_MS


def blake2b(data: bytes, size: int, key: bytes = b"") -> bytes:
    return hashlib.blake2b(data, digest_size=size, key=key).digest()


def u32(n: int) -> bytes:
    return struct.pack(">I", n)


def u16(n: int) -> bytes:
    return struct.pack(">H", n)


# --------------------------------------------------------------------------------------------
# Canonical JSON (README §4)
# --------------------------------------------------------------------------------------------

_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}


def _quote(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16(k: str) -> bytes:
    return k.encode("utf-16-be", "surrogatepass")


def canon(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        if not -MAX_SAFE <= v <= MAX_SAFE:
            raise fail("FORMAT", "canonical JSON: unsafe integer")
        return str(v)
    if isinstance(v, str):
        return _quote(v)
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16)
        return "{" + ",".join(_quote(k) + ":" + canon(v[k]) for k in keys) + "}"
    raise fail("FORMAT", "canonical JSON: unsupported value")


def _no_float(_: str) -> Any:
    raise fail("FORMAT", "canonical JSON: float")


def _no_constant(_: str) -> Any:
    raise fail("FORMAT", "canonical JSON: NaN/Infinity")


def parse_canonical(text: str, what: str) -> dict:
    """Transported text: parse, re-serialize canonically, compare (README §4)."""
    if not isinstance(text, str):
        raise fail("FORMAT", f"{what}: text expected")
    try:
        v = json.loads(text, parse_float=_no_float, parse_constant=_no_constant)
    except TLError:
        raise
    except (ValueError, RecursionError):
        raise fail("FORMAT", f"{what}: invalid JSON") from None
    if canon(v) != text:
        raise fail("FORMAT", f"{what}: non-canonical JSON")
    if not isinstance(v, dict):
        raise fail("FORMAT", f"{what}: object expected")
    return v


def utf8_strict(b: bytes, what: str) -> str:
    try:
        return b.decode("utf-8")  # strict; a leading BOM is kept (README §4)
    except UnicodeDecodeError:
        raise fail("FORMAT", f"{what}: invalid UTF-8") from None


# --------------------------------------------------------------------------------------------
# base64url, keys, hashes, dates (README §3)
# --------------------------------------------------------------------------------------------

_B64 = re.compile(r"^[A-Za-z0-9_-]*$")


def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def b64d(s: Any, what: str, length: int | None = None) -> bytes:
    if not isinstance(s, str) or not _B64.match(s) or len(s) % 4 == 1:
        raise fail("FORMAT", f"{what}: not base64url")
    b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    if b64e(b) != s:
        raise fail("FORMAT", f"{what}: non-canonical base64url")
    if length is not None and len(b) != length:
        raise fail("FORMAT", f"{what}: wrong length")
    return b


_PROBE = blake2b(b"TrianguLair/x25519-probe", 32)


def check_x25519(pk: bytes) -> None:
    """identity-and-keys.md §4."""
    if len(pk) != 32 or pk[31] & 0x80:
        raise fail("INVALID_KEY", "x25519: bad key")
    try:
        shared = sodium.crypto_scalarmult(_PROBE, pk)
    except Exception:
        raise fail("INVALID_KEY", "x25519: low order") from None
    if shared == bytes(32):
        raise fail("INVALID_KEY", "x25519: low order")


def parse_key(kind: str, value: Any, what: str = "key") -> bytes:
    prefix = kind + ":"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise fail("FORMAT", f"{what}: expected {prefix}")
    pk = b64d(value[len(prefix):], what, 32)
    if kind == "x25519":
        check_x25519(pk)
    return pk


def key_string(kind: str, pk: bytes) -> str:
    if kind == "x25519":
        check_x25519(pk)
    return f"{kind}:{b64e(pk)}"


def b2b256(data: bytes) -> str:
    return "b2b256:" + b64e(blake2b(data, 32))


_HASH = re.compile(r"^b2b256:([A-Za-z0-9_-]{43})$")


def check_hash(v: Any, what: str) -> str:
    m = _HASH.match(v) if isinstance(v, str) else None
    if not m:
        raise fail("FORMAT", f"{what}: bad hash")
    b64d(m.group(1), what, 32)
    return m.group(1)


_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.(\d{3}))?Z$")


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def iso_ms(v: Any, what: str) -> int:
    """A JSON date (README §3) -> epoch milliseconds."""
    m = _DATE.match(v) if isinstance(v, str) else None
    if not m:
        raise fail("FORMAT", f"{what}: bad date")
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    ms = int(m.group(8) or 0)
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    mdays = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if not (1 <= mo <= 12 and 1 <= d <= mdays[mo - 1] and h < 24 and mi < 60 and s < 60):
        raise fail("FORMAT", f"{what}: not a real instant")
    return ((_days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60000 + s * 1000 + ms


def iso_string(ms: int) -> str:
    days, rem = divmod(ms, DAY_MS)
    # civil_from_days
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    mo = mp + (3 if mp < 10 else -9)
    y += mo <= 2
    h, rem = divmod(rem, HOUR_MS)
    mi, rem = divmod(rem, 60000)
    s, msr = divmod(rem, 1000)
    return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}.{msr:03d}Z"


def is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def nonneg_int(doc: dict, k: str, what: str) -> int:
    v = doc.get(k)
    if not is_int(v) or v < 0:
        raise fail("FORMAT", f"{what}.{k}: non-negative integer expected")
    return v


def string(doc: dict, k: str, what: str) -> str:
    v = doc.get(k)
    if not isinstance(v, str):
        raise fail("FORMAT", f"{what}.{k}: string expected")
    return v


def obj(v: Any, what: str) -> dict:
    if not isinstance(v, dict):
        raise fail("FORMAT", f"{what}: object expected")
    return v


def array(doc: dict, k: str, what: str, maximum: int) -> list:
    v = doc.get(k)
    if not isinstance(v, list):
        raise fail("FORMAT", f"{what}.{k}: array expected")
    if len(v) > maximum:
        raise fail("FORMAT", f"{what}.{k}: too many entries")
    return v


def sorted_unique(lst: list, what: str) -> None:
    if any(not isinstance(x, str) for x in lst):
        raise fail("FORMAT", f"{what}: strings expected")
    if sorted(set(lst), key=_utf16) != lst:
        raise fail("FORMAT", f"{what}: must be sorted and unique")


# --------------------------------------------------------------------------------------------
# Read address (identity-and-keys.md §5)
# --------------------------------------------------------------------------------------------

_JS_SPACE = set("\t\n\v\f\r       　﻿") | {chr(c) for c in range(0x2000, 0x200B)}
_DOMAIN_FORBIDDEN = set(" #%/:<>?@[\\]^|") | {chr(c) for c in range(0x20)} | {"\x7f"}
_PATH_ENCODE = set(' "#<>?`{}')
_QUERY_ENCODE = set(" \"#<>'")
_DOT = {".", "%2e"}
_DOTDOT = {"..", ".%2e", "%2e.", "%2e%2e"}


def _ipv6_hextets(h: str) -> list[int] | None:
    halves = h.split("::")
    if len(halves) > 2:
        return None

    def part(p: str) -> list[int] | None:
        if p == "":
            return []
        out = []
        for x in p.split(":"):
            if not re.fullmatch(r"[0-9a-f]{1,4}", x):
                return None
            out.append(int(x, 16))
        return out

    head = part(halves[0])
    tail = part(halves[1]) if len(halves) == 2 else []
    if head is None or tail is None:
        return None
    fill = 8 - len(head) - len(tail)
    if (len(halves) == 1 and fill != 0) or (len(halves) == 2 and fill < 1):
        return None
    return head + [0] * (fill if len(halves) == 2 else 0) + tail


def _ipv6_serialize(x: list[int]) -> str:
    """URL Standard IPv6 serializer: compress the first longest run (length > 1) of zero pieces."""
    best, best_len, i = -1, 1, 0
    while i < 8:
        if x[i] == 0:
            j = i
            while j < 8 and x[j] == 0:
                j += 1
            if j - i > best_len:
                best, best_len = i, j - i
            i = j
        else:
            i += 1
    out, i = "", 0
    while i < 8:
        if i == best:
            out += "::" if i == 0 else ":"
            i += best_len
            continue
        out += format(x[i], "x") + (":" if i < 7 else "")
        i += 1
    return out


def _local_v4(a: int, b: int) -> bool:
    return a in (0, 10, 127) or (a == 100 and 64 <= b <= 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or a >= 224


def _local_v6(x: list[int]) -> bool:
    v4 = lambda hi: _local_v4(hi >> 8, hi & 0xFF)  # noqa: E731
    if x[:6] == [0] * 6:
        return True
    if x[:5] == [0] * 5 and x[5] == 0xFFFF:
        return v4(x[6])
    if x[:6] == [0x64, 0xFF9B, 0, 0, 0, 0]:
        return v4(x[6])
    if x[0] == 0x64 and x[1] == 0xFF9B and x[2] == 1:
        return True
    if x[0] == 0x2002:
        return v4(x[1])
    return (x[0] & 0xFFC0) == 0xFE80 or (x[0] & 0xFE00) == 0xFC00 or (x[0] & 0xFF00) == 0xFF00


def check_location(loc: Any, what: str = "location") -> None:
    """A conservative implementation without a URL Standard parser: it accepts only inputs that are
    already in their URL Standard serialization (see reference-reader/README.md, gap G-1)."""
    bad = fail("FORMAT", f"{what}: not a canonical public https address")
    if not isinstance(loc, str) or len(loc.encode("utf-8")) > 512 or not loc.startswith("https://"):
        raise bad
    if any(c in _JS_SPACE or ord(c) < 0x20 or c == "\x7f" or c in "#\\" for c in loc):
        raise bad
    if any(ord(c) > 0x7E for c in loc):
        raise bad  # non-ASCII is percent-encoded or punycoded by the serializer
    rest = loc[8:]
    m = re.match(r"^([^/?]*)(.*)$", rest)
    assert m
    authority, tail = m.group(1), m.group(2)
    if "@" in authority or authority == "":
        raise bad
    if authority.startswith("["):
        end = authority.find("]")
        if end < 0:
            raise bad
        host, after = authority[: end + 1], authority[end + 1 :]
        if after and not after.startswith(":"):
            raise bad
        port = after[1:] if after else None
    else:
        host, sep, port_s = authority.rpartition(":")
        if not sep:
            host, port = authority, None
        else:
            port = port_s
    if port is not None and (not re.fullmatch(r"0|[1-9][0-9]{0,4}", port) or int(port) > 65535 or int(port) == 443):
        raise bad
    if host.startswith("["):
        x = _ipv6_hextets(host[1:-1])
        if x is None or "[" + _ipv6_serialize(x) + "]" != host:
            raise bad
        local = _local_v6(x)
    else:
        if host == "" or any(c in _DOMAIN_FORBIDDEN or "A" <= c <= "Z" for c in host):
            raise bad
        labels = host.split(".")
        last = labels[-2] if labels[-1] == "" and len(labels) > 1 else labels[-1]
        if re.fullmatch(r"[0-9]+|0[xX][0-9a-fA-F]*", last):  # "ends in a number": an IPv4 host
            m4 = re.fullmatch(r"(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})", host)
            if not m4 or any(int(g) > 255 for g in m4.groups()):
                raise bad
            local = _local_v4(int(m4.group(1)), int(m4.group(2)))
        else:
            for label in labels:
                if label.startswith("xn--"):
                    try:
                        if label[4:].encode("ascii").decode("punycode").encode("punycode").decode("ascii") != label[4:]:
                            raise bad
                    except (UnicodeError, ValueError):
                        raise bad from None
            h = host[:-1] if host.endswith(".") else host
            local = h == "localhost" or h.endswith(".localhost") or h.endswith(".local") or h.endswith(".internal")
    if not tail.startswith("/"):
        raise bad
    path, q, query = tail.partition("?")
    if any(c in _PATH_ENCODE for c in path):
        raise bad
    for seg in path.split("/")[1:]:
        if seg.lower() in _DOT or seg.lower() in _DOTDOT:
            raise bad
    if q and any(c in _QUERY_ENCODE for c in query):
        raise bad
    if local:
        raise bad


# --------------------------------------------------------------------------------------------
# Signatures (README §5) and versioning (README §6)
# --------------------------------------------------------------------------------------------

PREFIX = b"TrianguLair-signature-v1\n"


def verify_sig(domain: str, sig: bytes, message: bytes, pk: bytes) -> None:
    try:
        VerifyKey(pk).verify(PREFIX + domain.encode() + b"\n" + message, sig)
    except (BadSignatureError, ValueError, TypeError):
        raise fail("SIGNATURE", f"{domain}: invalid signature") from None


def verify_doc(domain: str, doc: dict, pk: bytes, field_name: str = "signature") -> None:
    sig = b64d(doc.get(field_name), f"{domain}.{field_name}", 64)
    drop = {"signature", field_name}
    rest = {k: v for k, v in doc.items() if k not in drop}
    verify_sig(domain, sig, canon(rest).encode("utf-8"), pk)


_RESERVED = {"version", "minor", "crit", "signature", "type"}


def check_structure(doc: dict, name: str, major: int, required: list[str], optional: list[str] = (), supported_minor: int = 0) -> bool:
    v = doc.get("version")
    if not is_int(v) or v < 1:
        raise fail("FORMAT", f"{name}: bad version")
    if v != major:
        raise fail("UNSUPPORTED_VERSION", f"{name}: version {v}")
    minor = 0
    if "minor" in doc:
        m = doc["minor"]
        if not is_int(m) or m < 1:
            raise fail("FORMAT", f"{name}: bad minor")
        minor = m
    known = set(required) | set(optional) | {"version", "minor", "crit"}
    if "crit" in doc:
        c = doc["crit"]
        if not isinstance(c, list) or not 1 <= len(c) <= 32 or any(not isinstance(x, str) for x in c):
            raise fail("FORMAT", f"{name}: bad crit")
        if sorted(set(c), key=_utf16) != c:
            raise fail("FORMAT", f"{name}: crit must be sorted and unique")
        for f in c:
            if f in _RESERVED or f not in doc:
                raise fail("FORMAT", f"{name}: crit names a reserved or absent field")
            if f not in known:
                raise fail("UNSUPPORTED_VERSION", f"{name}: critical {f}", critical=f)
    for k in required:
        if k not in doc:
            raise fail("FORMAT", f"{name}: missing {k}")
    extensible = minor > supported_minor
    if not extensible:
        for k in doc:
            if k not in known:
                raise fail("FORMAT", f"{name}: unknown field {k}")
    return extensible


def check_fields(doc: dict, name: str, required: list[str], optional: list[str], extensible: bool) -> None:
    for k in required:
        if k not in doc:
            raise fail("FORMAT", f"{name}: missing {k}")
    if not extensible:
        for k in doc:
            if k not in required and k not in optional:
                raise fail("FORMAT", f"{name}: unknown field {k}")


# --------------------------------------------------------------------------------------------
# Certificates and identity move
# --------------------------------------------------------------------------------------------


def _as_doc(x: Any, what: str) -> dict:
    return parse_canonical(x, what) if isinstance(x, str) else obj(x, what)


def verify_sharing_cert(x: Any, expected_owner: str | None = None, retired: Iterable[str] = (), last_seen: dict | None = None) -> dict:
    """sharing-cert.md §2."""
    W = "sharing-cert"
    c = _as_doc(x, W)
    check_structure(c, W, 3, ["type", "version", "owner", "key", "rotation", "revoked_devices", "signature"], ["location"])
    if c["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    owner_pk = parse_key("ed25519", c["owner"], f"{W}.owner")
    parse_key("x25519", c["key"], f"{W}.key")
    r = c["rotation"]
    if not is_int(r) or not 0 <= r <= 0xFFFFFFFF:
        raise fail("FORMAT", f"{W}: bad rotation")
    if "location" in c:
        check_location(string(c, "location", W), f"{W}.location")
    revoked = array(c, "revoked_devices", W, 256)
    for d in revoked:
        parse_key("ed25519", d, f"{W}.revoked_devices[]")
    sorted_unique(revoked, f"{W}.revoked_devices")
    verify_doc(W, c, owner_pk)
    if c["owner"] in set(retired):
        raise fail("REVOKED", f"{W}: retired owner")
    if expected_owner is not None and expected_owner != c["owner"]:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    if last_seen is not None:
        cert_not_older(c, last_seen)
    return c


def cert_not_older(nxt: dict, last: dict) -> None:
    """sharing-cert.md §3."""
    if nxt["owner"] != last["owner"]:
        raise fail("OWNER_MISMATCH", "sharing-cert: lastSeen of another owner")
    if nxt["rotation"] < last["rotation"]:
        raise fail("ROLLBACK", "sharing-cert: older rotation", fork=False)
    if nxt["rotation"] == last["rotation"]:
        if canon(nxt) != canon(last):
            raise fail("ROLLBACK", "sharing-cert: fork", fork=True)
        return
    if any(d not in nxt["revoked_devices"] for d in last["revoked_devices"]):
        raise fail("ROLLBACK", "sharing-cert: un-revocation", fork=False)


def verify_device_cert(x: Any, expected_owner: str | None = None, retired: Iterable[str] = ()) -> dict:
    """device-cert.md §2."""
    W = "device-cert"
    c = _as_doc(x, W)
    check_structure(c, W, 1, ["type", "version", "owner", "device", "box", "signature"])
    if c["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    owner_pk = parse_key("ed25519", c["owner"], f"{W}.owner")
    parse_key("ed25519", c["device"], f"{W}.device")
    parse_key("x25519", c["box"], f"{W}.box")
    verify_doc(W, c, owner_pk)
    if c["owner"] in set(retired):
        raise fail("REVOKED", f"{W}: retired owner")
    if expected_owner is not None and expected_owner != c["owner"]:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    return c


def verify_identity_move(x: Any, expected_from: str | None = None) -> dict:
    """identity-move.md §2."""
    W = "identity-move"
    m = _as_doc(x, W)
    check_structure(m, W, 1, ["type", "version", "from", "to", "issued", "to_signature", "signature"])
    if m["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    from_pk = parse_key("ed25519", m["from"], f"{W}.from")
    to_pk = parse_key("ed25519", m["to"], f"{W}.to")
    if from_pk == to_pk:
        raise fail("FORMAT", f"{W}: from = to")
    iso_ms(m["issued"], f"{W}.issued")
    verify_doc("identity-move-to", m, to_pk, "to_signature")
    verify_doc(W, m, from_pk)
    if expected_from is not None and expected_from != m["from"]:
        raise fail("OWNER_MISMATCH", f"{W}: other identity")
    return m


# --------------------------------------------------------------------------------------------
# Signed index (signed-index.md)
# --------------------------------------------------------------------------------------------

MAX_INDEX = 16 * 1024 * 1024
_READS = re.compile(r"^[1-9][0-9]{0,3}(\.[0-9]{1,4})?$")
_PUBLIC = re.compile(r"^public/[A-Za-z0-9_-]{1,64}\.geojson$")
SHARING_IMPLIED = ("type", "version", "owner", "revoked_devices")
DEVICE_IMPLIED = ("type", "version", "owner")


@dataclass
class Index:
    doc: dict
    text: str
    cert: dict  # full sharing certificate
    owner_bound: bool = False
    read_from: str | None = None

    @property
    def owner(self) -> str:
        return self.doc["owner"]

    @property
    def rotation(self) -> int:
        return self.cert["rotation"]


@dataclass
class Anchor:
    version: int
    owner: str
    seq: int
    sharing_cert: dict
    hash: str


def full_sharing_cert(owner: str, revoked: Any, compact: Any) -> dict:
    c = obj(compact, "index.sharing_cert")
    for k in SHARING_IMPLIED:
        if k in c:
            raise fail("FORMAT", f"index.sharing_cert: {k} is implied")
    return {**c, "type": "sharing-cert", "version": 3, "owner": owner, "revoked_devices": revoked}


def verify_index(data: str | bytes, expected_owner: str | None = None, retired: Iterable[str] = (), last_seen: Index | Anchor | None = None,
                 location: str | None = None, now: int = 0) -> Index:
    """signed-index.md §4. `now` in epoch ms."""
    W = "index"
    retired = list(retired)
    if isinstance(data, bytes):
        if len(data) > MAX_INDEX:
            raise fail("FORMAT", f"{W}: too large")
        text = utf8_strict(data, W)
    else:
        text = data
        if len(text.encode("utf-16-le", "surrogatepass")) // 2 > MAX_INDEX:  # UTF-16 code units for a text input
            raise fail("FORMAT", f"{W}: too large")
    doc = parse_canonical(text, W)
    extensible = check_structure(doc, W, 4, ["version", "seq", "owner", "updated", "sharing_cert", "revoked_devices", "reads", "device_cert", "packs", "signature"],
                                 ["public", "move", "invitations"])
    parse_key("ed25519", doc["owner"], f"{W}.owner")
    owner = doc["owner"]
    nonneg_int(doc, "seq", W)
    updated = iso_ms(doc["updated"], f"{W}.updated")
    if updated > now + DAY_MS:
        raise fail("FORMAT", f"{W}: updated too far in the future")
    revoked = array(doc, "revoked_devices", W, 256)
    cert = verify_sharing_cert(full_sharing_cert(owner, revoked, doc["sharing_cert"]), retired=retired)
    if "location" not in cert:
        raise fail("FORMAT", f"{W}.sharing_cert: no location")
    certified = cert["location"]
    dco = obj(doc["device_cert"], f"{W}.device_cert")
    for k in DEVICE_IMPLIED:
        if k in dco:
            raise fail("FORMAT", f"{W}.device_cert: {k} is implied")
    dc = verify_device_cert({**dco, "type": "device-cert", "version": 1, "owner": owner})
    if dc["device"] in cert["revoked_devices"]:
        raise fail("REVOKED", f"{W}: signed by a revoked device")
    reads = array(doc, "reads", W, 32)
    if not reads or any(not isinstance(r, str) or not _READS.match(r) for r in reads) or len(set(reads)) != len(reads):
        raise fail("FORMAT", f"{W}: bad reads")
    packs = array(doc, "packs", W, 100_000)
    seen: set[str] = set()
    for p in packs:
        e = obj(p, f"{W}.packs[]")
        check_fields(e, f"{W}.packs[]", ["file", "hash"], [], extensible)
        h = check_hash(e["hash"], f"{W}.packs[].hash")
        f = string(e, "file", f"{W}.packs[]")
        if f not in (f"packs/b2b256-{h}.bin", f"media/b2b256-{h}.bin"):
            raise fail("FORMAT", f"{W}.packs[]: file does not match hash")
        if h in seen:
            raise fail("FORMAT", f"{W}.packs[]: duplicate")
        seen.add(h)
    if "public" in doc:
        pub = obj(doc["public"], f"{W}.public")
        check_fields(pub, f"{W}.public", ["file", "hash"], [], extensible)
        check_hash(pub["hash"], f"{W}.public.hash")
        if not _PUBLIC.match(string(pub, "file", f"{W}.public")):
            raise fail("FORMAT", f"{W}.public: bad file")
    if "invitations" in doc:
        inv = array(doc, "invitations", W, 256)
        if not inv:
            raise fail("FORMAT", f"{W}: empty invitations")
        for t in inv:
            check_hash(t, f"{W}.invitations[]")
        sorted_unique(inv, f"{W}.invitations")
    move = None
    if "move" in doc:
        move = verify_identity_move(obj(doc["move"], f"{W}.move"))
        if move["to"] != owner:
            raise fail("FORMAT", f"{W}: move does not lead to the owner")
    verify_doc(W, doc, parse_key("ed25519", dc["device"]))
    if owner in retired:
        raise fail("REVOKED", f"{W}: retired owner")
    if expected_owner is not None and expected_owner != owner:
        if move and move["from"] == expected_owner:
            raise fail("IDENTITY_MOVED", "moved", **{"from": move["from"], "to": move["to"], "conflict": False})
        if move and move["from"] in retired:
            raise fail("IDENTITY_MOVED", "conflict", **{"from": move["from"], "to": move["to"], "conflict": True})
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    idx = Index(doc=doc, text=text, cert=cert)
    if last_seen is not None:
        check_no_rollback(idx, last_seen)
    if location is not None and location != certified:
        raise fail("MOVED", "storage moved", location=certified)
    idx.owner_bound = expected_owner is not None
    idx.read_from = location
    return idx


def anchor_of(x: Index | Anchor) -> Anchor:
    if isinstance(x, Anchor):
        return x
    return Anchor(version=x.doc["version"], owner=x.owner, seq=x.doc["seq"], sharing_cert=x.cert, hash=b2b256(x.text.encode("utf-8")))


def anchor_from_json(text: str) -> Anchor:
    a = json.loads(text)
    return Anchor(version=a["version"], owner=a["owner"], seq=a["seq"], sharing_cert=a["sharing_cert"], hash=a["hash"])


def anchor_json(idx: Index) -> str:
    a = anchor_of(idx)
    return canon({"hash": a.hash, "owner": a.owner, "seq": a.seq, "sharing_cert": a.sharing_cert, "type": "index-anchor", "version": a.version})


def check_no_rollback(nxt: Index, last_seen: Index | Anchor) -> None:
    """signed-index.md §5."""
    last = anchor_of(last_seen)
    if nxt.owner != last.owner:
        raise fail("OWNER_MISMATCH", "index: lastSeen of another owner")
    if nxt.doc["version"] < last.version:
        raise fail("ROLLBACK", "index: older version", fork=False)
    cert_not_older(nxt.cert, last.sharing_cert)
    if nxt.rotation > last.sharing_cert["rotation"]:
        return
    seq = nxt.doc["seq"]
    if seq < last.seq:
        raise fail("ROLLBACK", "index: older seq", fork=False)
    if seq == last.seq:
        if b2b256(nxt.text.encode("utf-8")) != last.hash:
            raise fail("ROLLBACK", "index: fork", fork=True)
        return
    if seq - last.seq > 2**20:
        raise fail("ROLLBACK", "index: seq jump", fork=False)


def pad_key(vault_key: bytes) -> bytes:
    return blake2b(b"TrianguLair-invitation-padding-key-v1", 32, key=vault_key)


def listing(tokens: list[str], vault_key: bytes, now_ms: int) -> list[str]:
    """signed-index.md §6."""
    k = pad_key(vault_key)
    real = list(dict.fromkeys(tokens))
    size = 4
    while size < len(real):
        size *= 2
    if size > 256:
        raise fail("FORMAT", "index: too many open invitations")
    now_s = now_ms // 1000
    out = set(real)
    i = 0
    while len(out) < size:
        p = blake2b(b"TrianguLair-invitation-padding-period-v1\n" + u32(i), 8, key=k)
        period = 86400 + struct.unpack(">I", p[:4])[0] % 518401
        phase = struct.unpack(">I", p[4:])[0] % period
        epoch = (now_s + phase) // period
        out.add("b2b256:" + b64e(blake2b(b"TrianguLair-invitation-padding-v2\n" + u32(i) + u32(epoch), 32, key=k)))
        i += 1
    return sorted(out)


# --------------------------------------------------------------------------------------------
# Packs (pack.md) and group keys (group-key.md)
# --------------------------------------------------------------------------------------------

TYPES = {1: "content", 2: "group-key", 3: "media"}


def padme(n: int) -> int:
    if not is_int(n) or not 0 <= n <= 0xFFFFFFFF:
        raise fail("FORMAT", "pack: length out of range")
    if n <= 256:
        return 256
    e = n.bit_length() - 1
    s = e.bit_length()  # floor(log2 e) + 1
    step = 1 << (e - s)
    return -(-n // step) * step


def read_pack_header(b: bytes) -> tuple[dict, dict, bytes]:
    """pack.md §5 step 3: (header, protected header, ciphertext)."""
    W = "pack"
    if len(b) < 9:
        raise fail("FORMAT", f"{W}: too short")
    if b[:4] != b"TLPK":
        raise fail("FORMAT", f"{W}: bad magic")
    if b[4] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[4] != 4:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[4]}")
    n = struct.unpack(">I", b[5:9])[0]
    if n > 65536 or 9 + n > len(b):
        raise fail("FORMAT", f"{W}: bad header length")
    h = parse_canonical(utf8_strict(b[9 : 9 + n], f"{W} header"), f"{W} header")
    check_structure(h, f"{W} header", 4, ["type", "version", "alg", "wrapAlg", "nonce", "pad", "wraps"])
    if h["type"] != "pack":
        raise fail("FORMAT", f"{W}: wrong type")
    if h["alg"] != "xchacha20poly1305-ietf":
        raise fail("FORMAT", f"{W}: alg")
    if h["wrapAlg"] != "x25519-sealedbox":
        raise fail("FORMAT", f"{W}: wrapAlg")
    if h["pad"] not in ("padme", "none"):
        raise fail("FORMAT", f"{W}: pad")
    b64d(string(h, "nonce", W), f"{W}.nonce", 24)
    wraps = h["wraps"]
    if not isinstance(wraps, list) or not 1 <= len(wraps) <= 256:
        raise fail("FORMAT", f"{W}: bad wraps")
    for w in wraps:
        b64d(w, f"{W}.wrap", 80)
    ph = {k: v for k, v in h.items() if k != "wraps"}
    return h, ph, b[9 + n :]


@dataclass
class OpenedPack:
    id: str
    type: str
    payload: bytes
    file: str


def open_pack(b: bytes, index: Index, keys: list[tuple[bytes, bytes]]) -> OpenedPack:
    """pack.md §5. keys = [(public, secret)]."""
    W = "pack"
    if not index.owner_bound:
        raise fail("NOT_INDEXED", f"{W}: index not verified for its owner")
    h = b2b256(b)
    entry = next((p for p in index.doc["packs"] if p["hash"] == h), None)
    if entry is None:
        raise fail("NOT_INDEXED", f"{W}: not listed")
    header, ph, ct = read_pack_header(b)
    ad = b"TLPK\x04" + parse_key("ed25519", index.owner) + canon(ph).encode("utf-8")
    nonce = b64d(ph["nonce"], f"{W}.nonce", 24)
    unwrapped = False
    pt = None
    for w in header["wraps"]:
        wrap = b64d(w, f"{W}.wrap", 80)
        for pk, sk in keys:
            try:
                batch = sodium.crypto_box_seal_open(wrap, pk, sk)
            except Exception:
                continue
            unwrapped = True
            try:
                pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(ct, ad, nonce, batch)
                break
            except Exception:
                continue
        if pt is not None:
            break
    if pt is None:
        raise fail("DECRYPT" if unwrapped else "NO_MATCHING_KEY", f"{W}: cannot open")
    if len(pt) < 21:
        raise fail("FORMAT", f"{W}: plaintext too short")
    t = TYPES.get(pt[16])
    if t is None:
        raise fail("FORMAT", f"{W}: unknown payload type")
    n = struct.unpack(">I", pt[17:21])[0]
    if n > len(pt) - 21:
        raise fail("FORMAT", f"{W}: declared length too long")
    expected = padme(21 + n) if ph["pad"] == "padme" else 21 + n
    if len(pt) != expected:
        raise fail("FORMAT", f"{W}: bad padding length")
    if any(pt[21 + n :]):
        raise fail("FORMAT", f"{W}: non-zero padding")
    return OpenedPack(id=b64e(pt[:16]), type=t, payload=pt[21 : 21 + n], file=entry["file"])


def open_group_key(b: bytes, index: Index, keys: list[tuple[bytes, bytes]]) -> dict:
    """group-key.md §2."""
    W = "group-key"
    p = open_pack(b, index, keys)
    if p.type != "group-key":
        raise fail("FORMAT", f"{W}: not a group-key pack")
    doc = parse_canonical(utf8_strict(p.payload, W), W)
    check_structure(doc, W, 2, ["type", "version", "owner", "group", "generation", "secretKey"])
    if doc["type"] != "group-key":
        raise fail("FORMAT", f"{W}: wrong type")
    if string(doc, "owner", W) != index.owner:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    b64d(string(doc, "group", W), f"{W}.group", 16)
    gen = nonneg_int(doc, "generation", W)
    if gen < 1:
        raise fail("FORMAT", f"{W}: generation")
    sk = b64d(doc["secretKey"], f"{W}.secretKey", 32)
    return {"owner": doc["owner"], "group": doc["group"], "generation": gen, "secret": sk, "public": sodium.crypto_scalarmult_base(sk)}


# --------------------------------------------------------------------------------------------
# Invitation link (invitation-link.md)
# --------------------------------------------------------------------------------------------

MAX_TTL_MS = 7 * DAY_MS
SKEW_MS = 5 * 60 * 1000


def derive_invitation(seed: bytes) -> tuple[str, bytes, bytes]:
    sk = blake2b(b"TrianguLair-invitation-key-v1\n" + seed, 32)
    pk = sodium.crypto_scalarmult_base(sk)
    inv_id = b64e(blake2b(b"TrianguLair-invitation-id-v1\n" + seed, 16))
    return inv_id, pk, sk


def invitation_token(owner_pk: bytes, inv_pk: bytes, rotation: int, expires: int, location: str) -> str:
    loc = location.encode("utf-8")
    return b2b256(b"TrianguLair-invitation-listing-v2\n" + owner_pk + inv_pk + u32(rotation) + u32(expires) + u16(len(loc)) + loc)


@dataclass
class Received:
    id: str
    owner: str
    owner_pk: bytes
    location: str
    rotation: int
    expires: int  # seconds
    public: bytes
    secret: bytes
    token: str = field(default="")


def parse_invitation_link(link: Any, now: int) -> Received:
    """invitation-link.md §4."""
    W = "invitation-link"
    if not isinstance(link, str):
        raise fail("FORMAT", f"{W}: string expected")
    frag = link.split("#", 1)[1] if "#" in link else link
    if len(frag) > 750:
        raise fail("FORMAT", f"{W}: too long")
    b = b64d(frag, W)
    if len(b) < 1 or b[0] != 0x49:
        raise fail("FORMAT", f"{W}: bad magic")
    if len(b) < 2 or b[1] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[1] != 5:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[1]}")
    if len(b) < 58:
        raise fail("FORMAT", f"{W}: truncated")
    owner_pk, seed = b[2:34], b[34:50]
    rotation, expires = struct.unpack(">II", b[50:58])
    rest = b[58:]
    if not 1 <= len(rest) <= 504:
        raise fail("FORMAT", f"{W}: bad address length")
    location = "https://" + utf8_strict(rest, W)
    check_location(location, W)
    if expires * 1000 > now + MAX_TTL_MS + SKEW_MS:
        raise fail("FORMAT", f"{W}: expires too far ahead")
    inv_id, pk, sk = derive_invitation(seed)
    r = Received(inv_id, key_string("ed25519", owner_pk), owner_pk, location, rotation, expires, pk, sk)
    r.token = invitation_token(owner_pk, pk, rotation, expires, location)
    if now >= expires * 1000:
        raise fail("EXPIRED", f"{W}: expired")
    return r


def check_invitation_index(r: Received, idx: Index, now: int, last_seen: Index | Anchor | None = None) -> None:
    """invitation-link.md §5 (link path)."""
    W = "invitation"
    if not idx.owner_bound:
        raise fail("FORMAT", f"{W}: index not verified for an owner")
    if idx.read_from is None or idx.read_from != idx.cert["location"]:
        raise fail("FORMAT", f"{W}: index not read at its certified address")
    if idx.owner != r.owner:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    if idx.rotation < r.rotation:
        raise fail("ROLLBACK", f"{W}: index older than the link", fork=False)
    if idx.rotation != r.rotation:
        raise fail("NOT_LISTED", f"{W}: cancelled by a later rotation")
    if r.token not in idx.doc.get("invitations", []):
        raise fail("NOT_LISTED", f"{W}: not listed")
    if now >= r.expires * 1000:
        raise fail("EXPIRED", f"{W}: expired")
    if last_seen is not None:
        check_no_rollback(idx, last_seen)


# --------------------------------------------------------------------------------------------
# Safety code (safety-code.md)
# --------------------------------------------------------------------------------------------


def safety(a: str, b: str) -> tuple[list[str], str]:
    pa, pb = parse_key("ed25519", a), parse_key("ed25519", b)
    lo, hi = sorted([pa, pb])
    h = blake2b(b"TrianguLair-safety-v1" + lo + hi, 64)
    groups = ["%05d" % (int.from_bytes(h[5 * i : 5 * i + 5], "big") % 100000) for i in range(12)]
    return groups, "tlsafe1:" + b64e(h[:32])
