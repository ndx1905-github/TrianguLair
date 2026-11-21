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


# --------------------------------------------------------------------------------------------
# Recovery phrase -> identity (identity-and-keys.md §1)
# --------------------------------------------------------------------------------------------

import os as _os
import unicodedata as _ud

_BIP39_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"  # BIP-0039 english.txt


def _load_wordlist() -> list[str]:
    path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "bip39-english.txt")
    with open(path, "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != _BIP39_SHA256:
        raise RuntimeError("bip39-english.txt is not the BIP-0039 English list")
    words = raw.decode("ascii").split("\n")[:-1]
    assert len(words) == 2048
    return words


WORDLIST = _load_wordlist()
_WORD_INDEX = {w: i for i, w in enumerate(WORDLIST)}


def _js_trim(s: str) -> str:
    """ECMAScript String.prototype.trim (WhiteSpace and LineTerminator)."""
    ws = _JS_SPACE | {" ", " "}
    i, j = 0, len(s)
    while i < j and s[i] in ws:
        i += 1
    while j > i and s[j - 1] in ws:
        j -= 1
    return s[i:j]


def _js_split_ws(s: str, extra: str = "") -> list[str]:
    """Split on runs of ECMAScript \\s (plus the characters of `extra`)."""
    ws = _JS_SPACE | {" ", " "} | set(extra)
    out, cur, in_run = [], [], False
    for ch in s:
        if ch in ws:
            if not in_run:
                out.append("".join(cur))
                cur = []
            in_run = True
        else:
            cur.append(ch)
            in_run = False
    out.append("".join(cur))
    return out


def normalize_phrase(phrase: str) -> str:
    return " ".join(_js_split_ws(_js_trim(_ud.normalize("NFKD", phrase)).lower()))


def mnemonic_entropy(phrase: str) -> bytes:
    """12 BIP39 English words -> 16 bytes of entropy (checksum checked); else INVALID_PHRASE."""
    words = phrase.split(" ")
    if len(words) != 12 or any(w not in _WORD_INDEX for w in words):
        raise fail("INVALID_PHRASE", "phrase: not 12 words of the list")
    bits = 0
    for w in words:
        bits = (bits << 11) | _WORD_INDEX[w]
    entropy, checksum = (bits >> 4).to_bytes(16, "big"), bits & 0xF
    if hashlib.sha256(entropy).digest()[0] >> 4 != checksum:
        raise fail("INVALID_PHRASE", "phrase: bad checksum")
    return entropy


def kdf(length: int, sub_id: int, ctx: str, key: bytes) -> bytes:
    """libsodium crypto_kdf_derive_from_key (README §2)."""
    salt = struct.pack("<Q", sub_id) + bytes(8)
    person = ctx.encode("ascii") + bytes(8)
    return hashlib.blake2b(b"", digest_size=length, key=key, salt=salt, person=person).digest()


@dataclass
class Identity:
    owner: str
    master_pk: bytes
    master_seed: bytes
    vault_key: bytes


def _identity_from_seed(seed: bytes, vault_key: bytes) -> Identity:
    pk, _ = sodium.crypto_sign_seed_keypair(seed)
    return Identity(key_string("ed25519", pk), pk, seed, vault_key)


def identity_from_phrase(phrase: Any) -> Identity:
    if not isinstance(phrase, str):
        raise fail("INVALID_PHRASE", "phrase: string expected")
    entropy = mnemonic_entropy(normalize_phrase(phrase))
    root = blake2b(b"TrianguLair/root/v1", 32, key=entropy)
    return _identity_from_seed(kdf(32, 1, "TLmaster", root), kdf(32, 2, "TLvault_", root))


def decode_primary_identity(b: bytes) -> Identity:
    """identity-and-keys.md §2 (TLPI)."""
    if len(b) < 4 or b[:4] != b"TLPI":
        raise fail("FORMAT", "TLPI: bad magic")
    if len(b) < 5 or b[4] == 0:
        raise fail("FORMAT", "TLPI: bad version")
    if b[4] != 1:
        raise fail("UNSUPPORTED_VERSION", f"TLPI: version {b[4]}")
    if len(b) < 69:
        raise fail("FORMAT", "TLPI: truncated")
    if len(b) > 69:
        raise fail("FORMAT", "TLPI: trailing bytes")
    return _identity_from_seed(b[5:37], b[37:69])


# --------------------------------------------------------------------------------------------
# Sealed sharing key TLSK (identity-and-keys.md §6) and key export (key-export.md)
# --------------------------------------------------------------------------------------------


@dataclass
class DeviceHolder:
    device: str
    box_public: bytes
    box_secret: bytes


@dataclass
class SharingKey:
    cert: dict
    secret: bytes
    public: bytes
    vault_key: bytes


def _sharing_secret(doc: dict, cert: dict, W: str) -> SharingKey:
    secret = b64d(doc["secret"], f"{W}.secret", 32)
    public = sodium.crypto_scalarmult_base(secret)
    if public != parse_key("x25519", cert["key"], f"{W}.cert.key"):
        raise fail("FORMAT", f"{W}: secret does not match the certified key")
    vault_key = b64d(doc["vault_key"], f"{W}.vault_key", 32)
    return SharingKey(cert, secret, public, vault_key)


def open_sharing_key(b: bytes, holder: DeviceHolder | Identity, expected_owner: str | None = None, last_seen: dict | None = None) -> SharingKey:
    W = "TLSK"
    if len(b) < 4 or b[:4] != b"TLSK":
        raise fail("FORMAT", f"{W}: bad magic")
    if len(b) < 5 or b[4] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[4] != 2:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[4]}")
    if len(b) < 6:
        raise fail("FORMAT", f"{W}: no mode")
    mode = b[5]
    if mode == 1 and isinstance(holder, DeviceHolder):
        try:
            pt = sodium.crypto_box_seal_open(b[6:], holder.box_public, holder.box_secret)
        except Exception:
            raise fail("DECRYPT", f"{W}: cannot open") from None
        to = holder.device
    elif mode == 2 and isinstance(holder, Identity):
        if len(b) < 30:
            raise fail("FORMAT", f"{W}: truncated nonce")
        try:
            pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(b[30:], b[:30], b[6:30], holder.vault_key)
        except Exception:
            raise fail("DECRYPT", f"{W}: cannot open") from None
        to = holder.owner
        expected_owner = holder.owner
    else:
        raise fail("FORMAT", f"{W}: mode and holder do not match")
    doc = parse_canonical(utf8_strict(pt, W), W)
    check_structure(doc, "sharing-key", 2, ["type", "version", "to", "secret", "vault_key", "cert"])
    if doc["type"] != "sharing-key":
        raise fail("FORMAT", f"{W}: wrong type")
    if doc["to"] != to:
        raise fail("FORMAT", f"{W}: sealed for someone else")
    cert = verify_sharing_cert(obj(doc["cert"], f"{W}.cert"), expected_owner=expected_owner, last_seen=last_seen)
    return _sharing_secret(doc, cert, W)


def decode_key_export(b: bytes, expected_owner: str | None = None, retired: Iterable[str] = (), last_seen: dict | None = None) -> SharingKey:
    W = "key-export"
    doc = parse_canonical(utf8_strict(b, W), W)
    check_structure(doc, W, 3, ["type", "version", "secret", "vault_key", "cert"])
    if doc["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    cert = verify_sharing_cert(obj(doc["cert"], f"{W}.cert"), expected_owner=expected_owner, retired=retired, last_seen=last_seen)
    return _sharing_secret(doc, cert, W)


# --------------------------------------------------------------------------------------------
# Transfer blob TLTX and transfer code (transfer-blob.md)
# --------------------------------------------------------------------------------------------

_PREFIX4 = {w[:4]: w for w in WORDLIST}


def normalize_transfer_code(code: Any) -> str:
    if not isinstance(code, str):
        raise fail("INVALID_CODE", "code: string expected")
    parts = [p for p in _js_split_ws(_js_trim(_ud.normalize("NFKD", code).lower()), "-") if p]
    if len(parts) != 6:
        raise fail("INVALID_CODE", "code: 6 words expected")
    out = []
    for p in parts:
        w = _PREFIX4.get(p[:4]) if len(p) >= 3 else None
        if w is None or not w.startswith(p):
            raise fail("INVALID_CODE", "code: unknown word")
        out.append(w)
    return " ".join(out)


def decrypt_transfer(b: bytes, code: Any, now: int) -> bytes:
    W = "TLTX"
    if len(b) < 74 or b[:4] != b"TLTX":
        raise fail("FORMAT", f"{W}: too short or bad magic")
    if b[4] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[4] != 2:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[4]}")
    if b[5] != 1:
        raise fail("FORMAT", f"{W}: purpose")
    ops, mem, expires = struct.unpack(">III", b[6:18])
    if not 2 <= ops <= 10 or not 64 * 2**20 <= mem <= 256 * 2**20:
        raise fail("FORMAT", f"{W}: Argon2 parameters out of range")
    if now >= expires * 1000:
        raise fail("EXPIRED", f"{W}: expired")
    password = normalize_transfer_code(code).encode("utf-8")
    key = sodium.crypto_pwhash_alg(32, password, b[18:34], ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13)
    try:
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(b[58:], b[:58], b[34:58], key)
    except Exception:
        raise fail("DECRYPT", f"{W}: wrong code or tampered") from None


# --------------------------------------------------------------------------------------------
# Invitation records (invitation-record.md)
# --------------------------------------------------------------------------------------------

_RECORD_MEMBERS = ["answers", "created", "device_cert", "expires", "id", "location", "rotation", "seed", "signature"]


@dataclass
class OwnerInvitation:
    owner: str
    id: str
    seed: bytes
    public: bytes
    secret: bytes
    rotation: int
    device: str
    device_cert: dict
    location: str
    created: int  # ms
    expires: int  # ms
    signature: str


def _whole_second(v: Any, what: str) -> int:
    t = iso_ms(v, what)
    if t % 1000 or not 0 <= t // 1000 <= 0xFFFFFFFF:
        raise fail("FORMAT", f"{what}: not a u32 whole second")
    return t


def check_owner_invitation(inv: OwnerInvitation) -> None:
    """invitation-record.md §3, checkOwnerInvitation."""
    W = "invitation-record"
    owner_pk = parse_key("ed25519", inv.owner, f"{W}.owner")
    if not all(is_int(t) and t % 1000 == 0 and 0 <= t // 1000 <= 0xFFFFFFFF for t in (inv.created, inv.expires)):
        raise fail("FORMAT", f"{W}: dates")
    if inv.expires <= inv.created or inv.expires - inv.created > MAX_TTL_MS:
        raise fail("FORMAT", f"{W}: lifetime")
    if not is_int(inv.rotation) or not 0 <= inv.rotation <= 0xFFFFFFFF:
        raise fail("FORMAT", f"{W}: rotation")
    check_location(inv.location, f"{W}.location")
    if len(inv.seed) != 16:
        raise fail("FORMAT", f"{W}: seed")
    inv_id, pk, _ = derive_invitation(inv.seed)
    if inv_id != inv.id or pk != inv.public:
        raise fail("FORMAT", f"{W}: seed does not give the id and key")
    dc = verify_device_cert(inv.device_cert, expected_owner=inv.owner)
    if dc["device"] != inv.device:
        raise fail("FORMAT", f"{W}: device")
    sig = b64d(inv.signature, f"{W}.signature", 64)
    loc = inv.location.encode("utf-8")
    msg = owner_pk + b64d(inv.id, f"{W}.id", 16) + inv.public + u32(inv.rotation) + u32(inv.created // 1000) + u32(inv.expires // 1000) + u16(len(loc)) + loc
    verify_sig(W, sig, msg, parse_key("ed25519", inv.device, f"{W}.device"))


def record_invitation(rec: dict, owner: str) -> OwnerInvitation:
    """A vault record -> the owner's invitation (recordInvitation), checked."""
    W = "invitation-record"
    seed = b64d(rec.get("seed"), f"{W}.seed", 16)
    inv_id, pk, sk = derive_invitation(seed)
    if rec.get("id") != inv_id:
        raise fail("FORMAT", f"{W}: id does not match the seed")
    dco = obj(rec.get("device_cert"), f"{W}.device_cert")
    for k in DEVICE_IMPLIED:
        if k in dco:
            raise fail("FORMAT", f"{W}.device_cert: {k} is implied")
    dc = verify_device_cert({**dco, "type": "device-cert", "version": 1, "owner": owner}, expected_owner=owner)
    r = rec.get("rotation")
    if not is_int(r) or not 0 <= r <= 0xFFFFFFFF:
        raise fail("FORMAT", f"{W}: rotation")
    for k in ("location", "signature", "created", "expires"):
        string(rec, k, W)
    inv = OwnerInvitation(owner, inv_id, seed, pk, sk, r, dc["device"], dc, rec["location"],
                          _whole_second(rec["created"], f"{W}.created"), _whole_second(rec["expires"], f"{W}.expires"), rec["signature"])
    check_owner_invitation(inv)
    return inv


def invitation_status(inv: OwnerInvitation, cert: dict, now: int) -> str:
    """invitation-record.md §3, listable (never throws)."""
    if inv.owner != cert["owner"]:
        return "invalid"
    try:
        check_owner_invitation(inv)
    except TLError:
        return "invalid"
    if inv.device in cert["revoked_devices"]:
        return "revoked"
    if inv.expires <= now:
        return "expired"
    if inv.rotation < cert["rotation"]:
        return "superseded"
    if inv.rotation > cert["rotation"] or inv.created > now + SKEW_MS:
        return "not-yet"
    return "listed"


# --------------------------------------------------------------------------------------------
# Return link (return-link.md)
# --------------------------------------------------------------------------------------------

GRACE_MS = 7 * DAY_MS


@dataclass
class Answer:
    owner: str
    device: str
    cert: dict
    created: int  # ms
    location: str | None
    opened_after_expiry: bool


class _Reader:
    def __init__(self, b: bytes, what: str) -> None:
        self.b, self.i, self.what = b, 0, what

    def take(self, n: int) -> bytes:
        if self.i + n > len(self.b):
            raise fail("FORMAT", f"{self.what}: truncated")
        out = self.b[self.i : self.i + n]
        self.i += n
        return out

    def u16(self) -> int:
        return struct.unpack(">H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]


def open_invitation_response(b: bytes, inv: OwnerInvitation, now: int) -> Answer:
    W = "return-link"
    if len(b) < 2 or len(b) > 9600 or b[0] != 0x52:
        raise fail("FORMAT", f"{W}: bad size or magic")
    if b[1] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[1] != 4:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[1]}")
    if not is_int(inv.created) or not is_int(inv.expires):
        raise fail("FORMAT", f"{W}: invitation dates")
    if now >= inv.expires + GRACE_MS:
        raise fail("EXPIRED", f"{W}: past the grace period")
    try:
        inner = sodium.crypto_box_seal_open(b[2:], inv.public, inv.secret)
    except Exception:
        raise fail("DECRYPT", f"{W}: cannot open") from None
    r = _Reader(inner, W)
    if b64e(r.take(16)) != inv.id:
        raise fail("FORMAT", f"{W}: another invitation")
    responder = key_string("ed25519", r.take(32))
    created = r.u32()
    key = r.take(32)
    check_x25519(key)
    rotation = r.u32()
    n = r.u16()
    if n > 256:
        raise fail("FORMAT", f"{W}: too many revoked devices")
    revoked = [key_string("ed25519", r.take(32)) for _ in range(n)]
    L = r.u16()
    if L > 512:
        raise fail("FORMAT", f"{W}: address too long")
    location = None
    if L:
        location = utf8_strict(r.take(L), W)
        check_location(location, f"{W}.location")
    csig = r.take(64)
    cert_doc = {"key": key_string("x25519", key), "owner": responder, "revoked_devices": revoked, "rotation": rotation,
                "signature": b64e(csig), "type": "sharing-cert", "version": 3}
    if location is not None:
        cert_doc["location"] = location
    cert = verify_sharing_cert(cert_doc, expected_owner=responder)
    device_pk, box = r.take(32), r.take(32)
    check_x25519(box)
    dsig = r.take(64)
    dc = verify_device_cert({"box": key_string("x25519", box), "device": key_string("ed25519", device_pk), "owner": responder,
                             "signature": b64e(dsig), "type": "device-cert", "version": 1}, expected_owner=responder)
    sig = r.take(64)
    if r.i != len(inner):
        raise fail("FORMAT", f"{W}: trailing bytes")
    verify_sig("invitation-response", sig, inner[:-64] + parse_key("ed25519", inv.owner) + inv.public, device_pk)
    if created * 1000 < inv.created - SKEW_MS or created * 1000 >= inv.expires:
        raise fail("FORMAT", f"{W}: created outside the invitation's window")
    if dc["device"] in cert["revoked_devices"]:
        raise fail("REVOKED", f"{W}: revoked device")
    return Answer(responder, dc["device"], cert, created * 1000, location, now >= inv.expires)


@dataclass
class Collected:
    answers: list[Answer]
    rejected: int
    multiple: bool
    accepted: Answer | None
    late: list[Answer]


def collect_answers(inv: OwnerInvitation, responses: list[bytes], now: int, accepted_owner: str | None = None) -> Collected:
    if not is_int(inv.created) or not is_int(inv.expires):
        raise fail("FORMAT", "invitation: dates")
    by_owner: dict[str, Answer] = {}
    rejected = 0
    for resp in responses:
        try:
            a = open_invitation_response(resp, inv, now)
        except TLError as e:
            if e.code == "EXPIRED":
                raise
            rejected += 1
            continue
        cur = by_owner.get(a.owner)
        if cur is None or a.cert["rotation"] > cur.cert["rotation"]:
            by_owner[a.owner] = a
    answers = list(by_owner.values())
    if accepted_owner is None:
        return Collected(answers, rejected, len(answers) > 1, answers[0] if len(answers) == 1 else None, [])
    return Collected(answers, rejected, len(answers) > 1, by_owner.get(accepted_owner), [a for a in answers if a.owner != accepted_owner])


def check_answer_index(a: Answer, idx: Index) -> None:
    """return-link.md §6 (answer path), without lastSeen."""
    W = "answer"
    if not idx.owner_bound:
        raise fail("FORMAT", f"{W}: index not verified for an owner")
    if a.location is None:
        raise fail("FORMAT", f"{W}: no read address")
    if idx.read_from is None or idx.read_from != idx.cert["location"]:
        raise fail("FORMAT", f"{W}: index not read at its certified address")
    if idx.owner != a.owner:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    cert_not_older(idx.cert, a.cert)
    if a.device in idx.cert["revoked_devices"]:
        raise fail("REVOKED", f"{W}: revoked device")


# --------------------------------------------------------------------------------------------
# Recovery vault TLVD (vault.md)
# --------------------------------------------------------------------------------------------


def verify_index_anchor(x: Any, owner: str) -> dict:
    """signed-index.md §7."""
    W = "index-anchor"
    a = obj(x, W)
    if set(a) != {"hash", "owner", "seq", "sharing_cert", "type", "version"}:
        raise fail("FORMAT", f"{W}: members")
    if a["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    if not is_int(a["version"]) or a["version"] < 1:
        raise fail("FORMAT", f"{W}: version")
    parse_key("ed25519", a["owner"], f"{W}.owner")
    nonneg_int(a, "seq", W)
    check_hash(a["hash"], f"{W}.hash")
    verify_sharing_cert(obj(a["sharing_cert"], f"{W}.sharing_cert"), expected_owner=owner)
    if a["owner"] != owner:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    return a


def _check_vault_invitation(rec: Any, owner: str, extensible: bool) -> None:
    W = "vault.invitations[]"
    rec = obj(rec, W)
    check_fields(rec, W, _RECORD_MEMBERS, ["accepted"], extensible)
    b64d(rec["id"], f"{W}.id", 16)
    iso_ms(rec["created"], f"{W}.created")
    iso_ms(rec["expires"], f"{W}.expires")
    record_invitation(rec, owner)
    if "accepted" in rec:
        parse_key("ed25519", rec["accepted"], f"{W}.accepted")
    answers = array(rec, "answers", W, 16)
    for s in answers:
        if not isinstance(s, str) or len(s) > 13000:
            raise fail("FORMAT", f"{W}.answers[]: too long")
        b64d(s, f"{W}.answers[]")
    sorted_unique(answers, f"{W}.answers")


def check_vault_records(rec: dict, owner: str) -> dict:
    """vault.md §3 steps 5-9."""
    W = "vault-records"
    extensible = check_structure(rec, W, 3, ["type", "version", "owner", "contacts", "invitations", "retired_owners"], ["app"])
    if rec["type"] != W:
        raise fail("FORMAT", f"{W}: wrong type")
    if not isinstance(rec["owner"], str):
        raise fail("FORMAT", f"{W}: owner")
    if rec["owner"] != owner:
        raise fail("OWNER_MISMATCH", f"{W}: other owner")
    if "app" in rec and not isinstance(rec["app"], dict):
        raise fail("FORMAT", f"{W}: app")
    contacts = array(rec, "contacts", W, 10_000)
    for c in contacts:
        c = obj(c, f"{W}.contacts[]")
        check_fields(c, f"{W}.contacts[]", ["owner", "sharing_cert", "verified"], ["anchor"], extensible)
        parse_key("ed25519", c["owner"], f"{W}.contacts[].owner")
        if not isinstance(c["verified"], bool):
            raise fail("FORMAT", f"{W}.contacts[].verified")
        verify_sharing_cert(obj(c["sharing_cert"], f"{W}.contacts[].sharing_cert"), expected_owner=c["owner"])
        if "anchor" in c:
            verify_index_anchor(c["anchor"], c["owner"])
    owners = [c["owner"] for c in contacts]
    if any(a >= b for a, b in zip(owners, owners[1:])):
        raise fail("FORMAT", f"{W}: contacts not sorted")
    invitations = array(rec, "invitations", W, 256)
    for i in invitations:
        _check_vault_invitation(i, owner, extensible)
    ids = [i["id"] for i in invitations]
    if any(a >= b for a, b in zip(ids, ids[1:])):
        raise fail("FORMAT", f"{W}: invitations not sorted")
    retired = array(rec, "retired_owners", W, 256)
    sorted_unique(retired, f"{W}.retired_owners")
    for r in retired:
        parse_key("ed25519", r, f"{W}.retired_owners[]")
    return rec


def open_vault(b: bytes, owner: str, vault_key: bytes) -> dict:
    """vault.md §3."""
    W = "TLVD"
    if len(b) < 45 or b[:4] != b"TLVD":
        raise fail("FORMAT", f"{W}: too short or bad magic")
    if b[4] == 0:
        raise fail("FORMAT", f"{W}: bad version")
    if b[4] != 3:
        raise fail("UNSUPPORTED_VERSION", f"{W}: version {b[4]}")
    ad = b[:5] + parse_key("ed25519", owner, "owner") + b[5:29]
    try:
        pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(b[29:], ad, b[5:29], vault_key)
    except Exception:
        raise fail("DECRYPT", f"{W}: cannot open") from None
    if len(pt) < 4:
        raise fail("FORMAT", f"{W}: plaintext too short")
    j = struct.unpack(">I", pt[:4])[0]
    if j > len(pt) - 4 or len(pt) != padme(4 + j):
        raise fail("FORMAT", f"{W}: bad length")
    if any(pt[4 + j :]):
        raise fail("FORMAT", f"{W}: non-zero padding")
    return check_vault_records(parse_canonical(utf8_strict(pt[4 : 4 + j], W), W), owner)


def _anchor_rank(a: dict) -> tuple[int, int]:
    return (a["sharing_cert"]["rotation"], a["seq"])


def _merge_answers(a_rec: dict, b_rec: dict, owner: str) -> list[str]:
    union = sorted(set(a_rec["answers"]) | set(b_rec["answers"]))
    if len(union) <= 16:
        return union
    inv = record_invitation(a_rec, owner)
    accepted = a_rec.get("accepted", b_rec.get("accepted"))
    in_a = set(a_rec["answers"])
    best: dict[str, tuple[Answer, str]] = {}
    bad: list[str] = []
    for s in union:
        try:
            ans = open_invitation_response(b64d(s, "answer"), inv, inv.created)
        except TLError:
            bad.append(s)
            continue
        cur = best.get(ans.owner)
        if cur is None or ans.cert["rotation"] > cur[0].cert["rotation"] or (ans.cert["rotation"] == cur[0].cert["rotation"] and s < cur[1]):
            best[ans.owner] = (ans, s)
    good = sorted(best.values(), key=lambda x: (x[0].owner != accepted, x[1] not in in_a, x[1]))
    bad.sort(key=lambda s: (s not in in_a, s))
    return sorted(([s for _, s in good] + bad)[:16])


def merge_vaults(a: dict, b: dict) -> dict:
    """vault.md §4."""
    if a["owner"] != b["owner"]:
        raise fail("OWNER_MISMATCH", "vault: two owners")
    owner = a["owner"]
    out = {**{k: v for k, v in b.items()}, **a}
    bc = {c["owner"]: c for c in b["contacts"]}
    contacts = {}
    for c in a["contacts"]:
        o = bc.get(c["owner"])
        if o is None:
            contacts[c["owner"]] = c
            continue
        m = dict(c)
        if o["sharing_cert"]["rotation"] > c["sharing_cert"]["rotation"]:
            m["sharing_cert"] = o["sharing_cert"]
        m["verified"] = c["verified"] or o["verified"]
        if "anchor" in o and ("anchor" not in c or _anchor_rank(o["anchor"]) > _anchor_rank(c["anchor"])):
            m["anchor"] = o["anchor"]
        contacts[c["owner"]] = m
    for c in b["contacts"]:
        contacts.setdefault(c["owner"], c)
    out["contacts"] = [contacts[k] for k in sorted(contacts)]
    bi = {i["id"]: i for i in b["invitations"]}
    invs = {}
    for i in a["invitations"]:
        o = bi.get(i["id"])
        if o is None:
            invs[i["id"]] = i
            continue
        m = dict(i)
        m["answers"] = _merge_answers(i, o, owner)
        if "accepted" not in m and "accepted" in o:
            m["accepted"] = o["accepted"]
        invs[i["id"]] = m
    for i in b["invitations"]:
        invs.setdefault(i["id"], i)
    out["invitations"] = [invs[k] for k in sorted(invs)]
    out["retired_owners"] = sorted(set(a["retired_owners"]) | set(b["retired_owners"]))
    minors = [x["minor"] for x in (a, b) if "minor" in x]
    out.pop("minor", None)
    if minors:
        out["minor"] = max(minors)
    crit = sorted(set(a.get("crit", [])) | set(b.get("crit", [])), key=_utf16)
    out.pop("crit", None)
    if crit:
        out["crit"] = crit
    out.pop("app", None)
    if "app" in a or "app" in b:
        out["app"] = a.get("app", b.get("app"))
    return out
