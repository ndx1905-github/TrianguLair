"""Writes the INVENTED Mapstr fixtures: mapstr/mapstr.csv, mapstr/mapstr.geojson and mapstr.zip.

The places, addresses, comments and photo URLs are made up; the layout mirrors a real Mapstr
export (see src/formats/mapstr.ts). Run from anywhere: python3 make_fixtures.py
"""
import csv
import io
import json
import os
import struct
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PHOTO = "https://images.example.invalid/{:032x}_{:016x}.jpg"
COLORS = {
    "Restaurant": "#ff5161", "À essayer": "#ffb300", "Openair": "#4caf50", "Brunch": "#ff9800",
    "Bar": "#7e57c2", "Salon de thé / café": "#8d6e63", "Lire commentaire": "#9e9e9e", "Musée": "#2196f3",
}
PLACES = [
    dict(date="3/5/22 19:07", name="Crêperie des Lanternes", address="14 Rue des Lanternes, 75003 Paris, France",
         icon="restaurant", comment="Buckwheat crêpes, cider, friendly staff", rating="",
         tags=["Restaurant", "À essayer", "Openair", "Brunch"], lonlat=[2.36312, 48.86021],
         photos=[PHOTO.format(0xA1, 0xB1), PHOTO.format(0xA2, 0xB2)]),
    dict(date="11/28/23 20:15", name="Le Comptoir Inventé", address="3 Passage de l'Exemple, 75004 Paris, France",
         icon="bar", comment='Natural wines; ask for the "wine of the day"', rating="4",
         tags=["Bar", "Salon de thé / café"], lonlat=[2.35788, 48.85872], photos=[]),
    dict(date="1/2/24 9:00", name="Salon Thé Fictif", address="27 Rue Imaginaire, 75003 Paris, France",
         icon="tea", comment="", rating="",
         tags=["Salon de thé / café", "Lire commentaire"], lonlat=[2.36504, 48.85731], photos=[]),
    dict(date="7/14/24 8:30", name="Musée des Objets Perdus", address="8 Impasse Inconnue, 75003 Paris, France",
         icon="museum", comment="Closed on Mondays", rating="5",
         tags=["Musée"], lonlat=[2.35451, 48.86190], photos=[]),
]


def csv_text():
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["date", "name", "address", "icon", "userComment", "rating", "tags", "photos"])
    for p in PLACES:
        w.writerow([p["date"], p["name"], p["address"], p["icon"], p["comment"], p["rating"], "#".join(p["tags"]), ",".join(p["photos"])])
    return "﻿" + out.getvalue()


def geojson_text():
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": p["lonlat"]},
        "properties": {"name": p["name"], "address": p["address"], "icon": p["icon"], "userComment": p["comment"],
                       "tags": [{"name": t, "color": COLORS[t]} for t in p["tags"]]},
    } for p in PLACES]
    return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))


def apple_double():
    # A minimal AppleDouble header, like the macOS "._" files the real ZIP carries.
    return struct.pack(">IIH", 0x00051607, 0x00020000, 0) + b"Mac OS X        " + b"\0" * 16


def main():
    os.makedirs(os.path.join(HERE, "mapstr"), exist_ok=True)
    c, g = csv_text(), geojson_text()
    with open(os.path.join(HERE, "mapstr", "mapstr.csv"), "w", encoding="utf-8", newline="") as f:
        f.write(c)
    with open(os.path.join(HERE, "mapstr", "mapstr.geojson"), "w", encoding="utf-8") as f:
        f.write(g)
    # A GeoJSON cut short (an invalid file): the import must say so clearly.
    with open(os.path.join(HERE, "invalid.geojson"), "w", encoding="utf-8") as f:
        f.write(g[: g.rindex('"tags"')])
    entries = [
        ("mapstr/", b""),
        ("__MACOSX/._mapstr", apple_double()),
        ("mapstr/mapstr.geojson", g.encode()),
        ("__MACOSX/mapstr/._mapstr.geojson", apple_double()),
        ("mapstr/mapstr.csv", c.encode()),
        ("__MACOSX/mapstr/._mapstr.csv", apple_double()),
    ]
    with zipfile.ZipFile(os.path.join(HERE, "mapstr.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(zipfile.ZipInfo(name, date_time=(2024, 7, 14, 8, 30, 0)), data)


if __name__ == "__main__":
    main()
