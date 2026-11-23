// SPDX-License-Identifier: MPL-2.0
/**
 * @triangulair/import — bring places in from Google Takeout, KML/KMZ,
 * GeoJSON, CSV, Mapstr and Pin Drop (Pin Drop UNVERIFIED), match them to
 * OpenStreetMap, preview, write them in batches; and the full GeoJSON export.
 */
export * from './model.ts';
export { parseCsv, parseCsvRows, sniffDelimiter, stripBom, toCsv, csvField, type CsvTable } from './csv.ts';
export { parseXml, type XmlElement } from './xml.ts';
export { parseGoogleMapsUrl, isGoogleMapsUrl, cidFromFid, parseLatLonText, type GoogleUrlInfo } from './google.ts';
export { parseDate, parseStatus, normalizeColor, splitTags, stripHtml } from './util.ts';
export {
  parseGoogleSavedPlaces,
  parseGoogleLabeledPlaces,
  parseGenericGeoJson,
  isGoogleSavedPlaces,
  isGoogleLabeledPlaces,
} from './formats/geojson.ts';
export {
  guessMapping,
  mappingProblems,
  parseCsvWithMapping,
  parseGoogleSavedCsv,
  isGoogleSavedCsv,
  statusFromListName,
  CSV_FIELDS,
  type ColumnMapping,
  type CsvField,
} from './formats/csv.ts';
export { parseKml, parseKmz, kmlFromKmz, isZip } from './formats/kml.ts';
export {
  parseMapstr,
  parseMapstrZip,
  parseMapstrCsv,
  parseMapstrGeoJson,
  parseMapstrDate,
  splitMapstrTags,
  joinMapstrRows,
  mapstrIconCategory,
  isMapstrCsv,
  isMapstrGeoJson,
  isMapstrZip,
  InvalidGeoJsonError,
  MAPSTR_CSV_HEADER,
  MAPSTR_ICON_CATEGORIES,
  type MapstrFiles,
} from './formats/mapstr.ts';
export { parsePinDropCsv, parsePinDropKml } from './formats/unverified/pindrop.ts';
export {
  buildExport,
  exportGeoJson,
  exportFileName,
  parseTriangulairExport,
  parseTriangulairArchive,
  isTriangulairExport,
  isTriangulairArchive,
  exportArchive,
  ARCHIVE_DOCUMENT,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  EXPORT_MINOR,
  type ExportDocument,
  type ExportOptions,
  type ExportProperties,
  type ExportMeta,
  type ExportPhoto,
  type ExportFile,
  type ArchiveOptions,
} from './formats/triangulair.ts';
export { readImportFile, readCsvWithMapping, type ReadOutcome } from './detect.ts';
export * from './match.ts';
export * from './plan.ts';
export * from './apply.ts';
export { suggestTag, tagKey, tagRole, editDistance, TAG_SYNONYMS, TAG_ROLE_NAMES, type TagSuggestion, type TagMatchReason, type MatchableTag, type TagRole } from './tagMatch.ts';
