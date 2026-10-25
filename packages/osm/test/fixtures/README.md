# Test fixtures

These responses are **synthetic**: they were written by hand from the
documented response formats of each service (Overpass JSON output, Photon
GeoJSON, Nominatim `jsonv2`, OSM API 0.6 JSON, MediaWiki/Commons
`formatversion=2` with `extmetadata`, Wikidata `wbgetentities`, Panoramax
STAC search), because the development sandbox had no access to the live
services. Places, people, ids and photo files are fictional.

Before relying on a format detail, re-record a real answer and compare:

```sh
curl -A "TrianguLair-dev (+https://github.com/…)" \
  --data-urlencode 'data=[out:json];node(around:150,48.859,2.362)[name][amenity];out tags center;' \
  https://overpass-api.de/api/interpreter
```
