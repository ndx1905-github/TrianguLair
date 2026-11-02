/**
 * Pieces of the import screen: column mapping (generic CSV), preview rows
 * with their choices, tag mapping, progress bar.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  CSV_FIELDS,
  type ColumnMapping,
  type CsvField,
  type CsvTable,
  type PlanItem,
  type Resolution,
  type TagAction,
  type TagPlanEntry,
} from '@triangulair/import';

import { Pill } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { AppTag } from '../places/model';
import { formatDistanceM, rowOutcome } from './logic';

// ------------------------------------------------------------------ progress

export function ProgressBar({ done, total, testID }: { done: number; total: number; testID?: string }) {
  const c = useUiColors();
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <View
      style={[styles.bar, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: done }}
      testID={testID}
    >
      <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: c.accent }]} />
    </View>
  );
}

// ------------------------------------------------------------------ column mapping

/** The field a column is mapped to (tags and comments may span several columns). */
function fieldOf(m: ColumnMapping, col: number): CsvField | null {
  for (const f of CSV_FIELDS) {
    const v = m[f];
    if (Array.isArray(v) ? v.includes(col) : v === col) return f;
  }
  return null;
}

export function setColumnField(m: ColumnMapping, col: number, field: CsvField | null): ColumnMapping {
  const next: ColumnMapping = { ...m, ...(m.tags && { tags: m.tags.filter((i) => i !== col) }), ...(m.comment && { comment: m.comment.filter((i) => i !== col) }) };
  for (const f of CSV_FIELDS) {
    if (f === 'tags' || f === 'comment') continue;
    if (next[f] === col) delete next[f];
  }
  if (field === 'tags' || field === 'comment') next[field] = [...(next[field] ?? []), col];
  else if (field) next[field] = col;
  return next;
}

export function ColumnMappingEditor({ table, mapping, onChange }: { table: CsvTable; mapping: ColumnMapping; onChange: (m: ColumnMapping) => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View style={{ gap: 10 }} testID="column-mapping">
      {table.headers.map((h, col) => {
        const current = fieldOf(mapping, col);
        const sample = table.rows.map((r) => r[col]?.trim()).find((v) => v);
        return (
          <View key={col} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]} testID={`column-${col}`}>
            <Text style={[styles.rowName, { color: c.text }]} maxFontSizeMultiplier={2}>
              {h || `#${col + 1}`}
            </Text>
            {sample ? (
              <Text style={[styles.meta, { color: c.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={2}>
                {t('import.mapping.sample', { value: sample })}
              </Text>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
              <Pill label={t('import.mapping.ignore')} selected={current === null} onPress={() => onChange(setColumnField(mapping, col, null))} muted={current !== null} />
              {CSV_FIELDS.map((f) => (
                <Pill
                  key={f}
                  label={t(`import.mapping.field.${f}`)}
                  selected={current === f}
                  onPress={() => onChange(setColumnField(mapping, col, f))}
                  testID={`column-${col}-${f}`}
                />
              ))}
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ preview rows

function sameResolution(a: Resolution, b: Resolution): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'osm' && b.kind === 'osm') return a.candidate.ref.type === b.candidate.ref.type && a.candidate.ref.id === b.candidate.ref.id;
  return true;
}

export function PreviewRow({
  item,
  sourceTagNames,
  onResolve,
  initiallyOpen = false,
}: {
  item: PlanItem;
  sourceTagNames: Map<string, string>;
  onResolve: (r: Resolution) => void;
  initiallyOpen?: boolean;
}) {
  const c = useUiColors();
  const { t } = useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const outcome = rowOutcome(item);
  const r = item.resolution;
  const target =
    r.kind === 'osm'
      ? [r.candidate.name, formatDistanceM(item.match.candidates.find((x) => x.ref.id === r.candidate.ref.id)?.distanceM ?? null)].filter(Boolean).join(' · ')
      : null;
  const tagLine = item.place.tags.map((k) => sourceTagNames.get(k) ?? k).join(', ');
  const choices: { key: string; label: string; resolution: Resolution }[] = [
    ...item.match.candidates.map((cand) => ({
      key: `${cand.ref.type}/${cand.ref.id}`,
      label: t('import.choice.candidate', { name: cand.name, distance: formatDistanceM(cand.distanceM) ?? cand.address ?? '' }).replace(/ · $/, ''),
      resolution: { kind: 'osm' as const, candidate: cand },
    })),
    ...(item.position || item.place.shape ? [{ key: 'manual', label: t('import.choice.manual'), resolution: { kind: 'manual' as const } }] : []),
    { key: 'skip', label: t('import.choice.skip'), resolution: { kind: 'skip' as const } },
  ];
  const tone = outcome === 'skip' ? c.textMuted : outcome === 'merge' || outcome === 'duplicate' ? c.warning : c.accent;
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, opacity: outcome === 'skip' ? 0.6 : 1 }]} testID={`preview-row-${item.place.name}`}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.rowHead}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowName, { color: c.text }]} maxFontSizeMultiplier={2}>
            {item.place.name}
          </Text>
          {tagLine || item.place.comment ? (
            <Text style={[styles.meta, { color: c.textMuted }]} numberOfLines={2} maxFontSizeMultiplier={2}>
              {[tagLine, item.place.comment].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <Text style={[styles.outcome, { color: tone }]} maxFontSizeMultiplier={2}>
            {target ? `→ ${target}` : t(`import.row.${outcome}`)}
            {target && outcome !== 'link' ? `  ·  ${t(`import.row.${outcome}`)}` : ''}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: c.textMuted }]}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.choices}>
          {choices.map((ch) => (
            <Pill key={ch.key} label={ch.label} selected={sameResolution(ch.resolution, r)} onPress={() => onResolve(ch.resolution)} testID={`choice-${item.place.name}-${ch.key}`} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ tags

export function TagMappingRow({ entry, myTags, onChange }: { entry: TagPlanEntry; myTags: readonly AppTag[]; onChange: (a: TagAction) => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const a = entry.action;
  const newColor = a.kind === 'create' ? (a.color ?? c.textMuted) : entry.source.color ?? c.textMuted;
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]} testID={`tag-row-${entry.source.name}`}>
      <View style={styles.rowHead}>
        <View style={[styles.dot, { backgroundColor: entry.source.color ?? newColor }]} />
        <Text style={[styles.rowName, { color: c.text, flex: 1 }]} maxFontSizeMultiplier={2}>
          {entry.source.name}
        </Text>
        <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('import.tags.count', { count: entry.count })}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
        <Pill
          label={t('import.tags.new')}
          color={newColor}
          selected={a.kind === 'create'}
          onPress={() => onChange({ kind: 'create', name: entry.source.name, color: entry.source.color ?? (a.kind === 'create' ? a.color : null) ?? '#475569' })}
          testID={`tag-${entry.source.name}-new`}
        />
        {myTags.map((tag) => (
          <Pill
            key={tag.id}
            label={tag.name}
            color={tag.color}
            selected={a.kind === 'map' && a.tagId === tag.id}
            onPress={() => onChange({ kind: 'map', tagId: tag.id })}
            testID={`tag-${entry.source.name}-map-${tag.name}`}
          />
        ))}
        <Pill label={t('import.tags.skip')} selected={a.kind === 'skip'} onPress={() => onChange({ kind: 'skip' })} muted={a.kind !== 'skip'} testID={`tag-${entry.source.name}-skip`} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: 10, borderRadius: 5, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  barFill: { height: '100%', borderRadius: 5 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowName: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13 },
  outcome: { fontSize: 14, fontWeight: '600', marginTop: 2 },
  chevron: { fontSize: 16, paddingHorizontal: 4 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 4 },
  pills: { gap: 6, paddingVertical: 2 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
