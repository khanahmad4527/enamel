<template>
  <div class="tooth-chart">
    <div v-if="loading" class="state">{{ m.loading }}</div>

    <div v-else-if="!patientId" class="state">
      {{ m.unsavedPatient }}
    </div>

    <template v-else>
      <div class="arch">
        <span class="arch-label">{{ m.upper }}</span>
        <div class="teeth">
          <button
            v-for="fdi in UPPER_ARCH"
            :key="fdi"
            type="button"
            class="tooth"
            :class="{ selected: selected === fdi }"
            :style="{ width: toothWidth(fdi) + 'px' }"
            :title="`${fdi} · ${toothLabel(fdi)} — ${conditionLabel(conditionOf(fdi))}`"
            :aria-label="`${m.tooth} ${fdi}, ${toothLabel(fdi)}, ${conditionLabel(conditionOf(fdi))}`"
            @click="select(fdi)"
          >
            <svg viewBox="0 0 32 40" class="glyph" aria-hidden="true">
              <path
                :d="CROWN_UP"
                :fill="styleFor(fdi).absent ? 'none' : styleFor(fdi).fill"
                :stroke="styleFor(fdi).stroke"
                :stroke-width="styleFor(fdi).absent ? 1.6 : 1.5"
                :stroke-dasharray="styleFor(fdi).absent ? '3 3' : undefined"
              />
              <path
                v-if="styleFor(fdi).absent"
                d="M7 8 L25 32"
                :stroke="styleFor(fdi).stroke"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <span class="fdi">{{ fdi }}</span>
          </button>
        </div>
      </div>

      <div class="midline" role="presentation"></div>

      <div class="arch">
        <span class="arch-label">{{ m.lower }}</span>
        <div class="teeth">
          <button
            v-for="fdi in LOWER_ARCH"
            :key="fdi"
            type="button"
            class="tooth lower"
            :class="{ selected: selected === fdi }"
            :style="{ width: toothWidth(fdi) + 'px' }"
            :title="`${fdi} · ${toothLabel(fdi)} — ${conditionLabel(conditionOf(fdi))}`"
            :aria-label="`${m.tooth} ${fdi}, ${toothLabel(fdi)}, ${conditionLabel(conditionOf(fdi))}`"
            @click="select(fdi)"
          >
            <span class="fdi">{{ fdi }}</span>
            <svg viewBox="0 0 32 40" class="glyph" aria-hidden="true">
              <path
                :d="CROWN_DOWN"
                :fill="styleFor(fdi).absent ? 'none' : styleFor(fdi).fill"
                :stroke="styleFor(fdi).stroke"
                :stroke-width="styleFor(fdi).absent ? 1.6 : 1.5"
                :stroke-dasharray="styleFor(fdi).absent ? '3 3' : undefined"
              />
              <path
                v-if="styleFor(fdi).absent"
                d="M7 32 L25 8"
                :stroke="styleFor(fdi).stroke"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="legend">
        <span v-for="(s, key) in CONDITION_STYLE" :key="key" class="legend-item">
          <i
            :class="{ absent: s.absent }"
            :style="{ background: s.absent ? 'transparent' : s.fill, borderColor: s.stroke }"
          ></i>{{ conditionLabel(key) }}
        </span>
      </div>

      <div v-if="selected" class="detail">
        <div class="detail-head">
          <strong>{{ selected }} · {{ toothLabel(selected) }}</strong>
          <span class="pill" :style="{ background: styleFor(selected).fill, color: styleFor(selected).text, borderColor: styleFor(selected).stroke }">
            {{ conditionLabel(conditionOf(selected)) }}
          </span>
        </div>
        <ul v-if="historyFor(selected).length" class="history">
          <li v-for="f in historyFor(selected)" :key="f.id">
            <span class="when">{{ formatDate(f.recorded_at) }}</span>
            <span class="what">{{ conditionLabel(f.condition) }}</span>
            <span v-if="f.surface && f.surface !== 'whole'" class="surface">{{ m.surfaces[f.surface] ?? f.surface }}</span>
            <span v-if="f.notes" class="notes">{{ f.notes }}</span>
          </li>
        </ul>
        <p v-else class="state small">{{ m.noFindings }}</p>
      </div>

      <p v-if="error" class="state error">{{ error }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18nSafe } from "./i18n";
import { useApi } from "@directus/extensions-sdk";
import {
  UPPER_ARCH, LOWER_ARCH, CONDITION_STYLE, toothAnatomy, toothWidth,
  latestByTooth, type Finding, type Condition,
} from "./teeth";
import { messagesFor } from "./messages";

const props = defineProps<{
  /** Injected by Directus: the row currently open. */
  primaryKey?: string | number;
  collection?: string;
}>();

const api = useApi();

/**
 * Directus injects vue-i18n into app extensions, but guard it anyway: a
 * missing locale must degrade to English, never throw and blank the
 * whole field.
 */
const locale = computed(() => {
  try {
    const i18n = useI18nSafe();
    return i18n ? String(i18n.locale.value) : undefined;
  } catch {
    return undefined;
  }
});
const m = computed(() => messagesFor(locale.value));

function conditionLabel(c: Condition | string): string {
  return m.value.conditions[c] ?? String(c);
}

function toothLabel(fdi: number): string {
  const a = toothAnatomy(fdi);
  const arch = a.arch === "upper" ? m.value.archUpper : m.value.archLower;
  const side = a.side === "right" ? m.value.sideRight : m.value.sideLeft;
  const name = m.value.positions[a.position - 1] ?? m.value.tooth;
  return `${arch} ${side} — ${name}`;
}
const findings = ref<Finding[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const selected = ref<number | null>(null);

const patientId = computed(() =>
  props.primaryKey && props.primaryKey !== "+" ? String(props.primaryKey) : null,
);

const CROWN_UP =
  "M16 2.5c-8 0-12 4.4-12 10.7 0 3.7 1.1 6.6 2.1 11 .6 2.7 1.2 5.8 1.8 7.3.5 1.4 1.3 2.2 2.5 2.2 2 0 2.6-2 3-5.1.3-2.9.8-6.2 1.2-8.2.3-1.5.8-2.3 1.4-2.3s1.1.8 1.4 2.3c.4 2 .9 5.3 1.2 8.2.4 3.1 1 5.1 3 5.1 1.2 0 2-.8 2.5-2.2.6-1.5 1.2-4.6 1.8-7.3 1-4.4 2.1-7.3 2.1-11C28 6.9 24 2.5 16 2.5z";
const CROWN_DOWN =
  "M16 37.5c-8 0-12-4.4-12-10.7 0-3.7 1.1-6.6 2.1-11 .6-2.7 1.2-5.8 1.8-7.3.5-1.4 1.3-2.2 2.5-2.2 2 0 2.6 2 3 5.1.3 2.9.8 6.2 1.2 8.2.3 1.5.8 2.3 1.4 2.3s1.1-.8 1.4-2.3c.4-2 .9-5.3 1.2-8.2.4-3.1 1-5.1 3-5.1 1.2 0 2 .8 2.5 2.2.6 1.5 1.2 4.6 1.8 7.3 1 4.4 2.1 7.3 2.1 11 0 6.3-4 10.7-12 10.7z";

const current = computed(() => latestByTooth(findings.value));

function conditionOf(fdi: number): Condition {
  return (current.value.get(fdi)?.condition ?? "healthy") as Condition;
}

function styleFor(fdi: number) {
  return CONDITION_STYLE[conditionOf(fdi)] ?? CONDITION_STYLE.healthy;
}

function historyFor(fdi: number): Finding[] {
  return findings.value
    .filter((f) => f.tooth_fdi === fdi)
    .sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? ""));
}

function select(fdi: number) {
  selected.value = selected.value === fdi ? null : fdi;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale.value || undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

async function load() {
  if (!patientId.value) { loading.value = false; return; }
  loading.value = true;
  error.value = null;
  try {
    const res = await api.get("/items/tooth_conditions", {
      params: {
        limit: -1,
        sort: "-recorded_at",
        fields: ["id", "tooth_fdi", "surface", "condition", "recorded_at", "notes"],
        filter: { patient: { _eq: patientId.value } },
      },
    });
    findings.value = (res.data?.data ?? []) as Finding[];
  } catch (e: unknown) {
    // A 403 here is not a bug — front-desk policies deny this collection
    // outright, and the interface should say so rather than look broken.
    const status = (e as { response?: { status?: number } })?.response?.status;
    error.value = status === 403 ? m.value.noAccess : m.value.loadFailed;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(patientId, load);
</script>

<style scoped>
.tooth-chart {
  --line: var(--theme--form--field--input--border-color, #dfe2e5);
  border: 1px solid var(--line);
  border-radius: var(--theme--border-radius, 6px);
  padding: 20px 18px 16px;
  background: var(--theme--background, #fff);
}
.state { color: var(--theme--foreground-subdued, #7a8b99); font-size: 14px; padding: 8px 0; }
.state.small { font-size: 13px; }
.state.error { color: var(--theme--danger, #e35169); }

.arch {
  /* Label above the arch, not beside it. A side gutter cannot be sized
     for every language at once — "UPPER" is five characters,
     "MANDIBULAIRE" is twelve — so a gutter fitted to English clips the
     German label onto the first tooth, and one fitted to French steals
     width from every arch. Stacking removes the constraint, and both
     arches keep the full measure in all four locales. */
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.arch-label {
  font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--theme--foreground-subdued, #7a8b99);
  line-height: 1.25;
  overflow-wrap: break-word;
}
.teeth { display: flex; align-items: flex-end; gap: 3px; overflow-x: auto; padding-bottom: 2px; }
.arch:last-of-type .teeth { align-items: flex-start; }

.tooth {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  background: none; border: 0; padding: 4px 1px 7px; cursor: pointer; flex: none;
  border-radius: 5px;
  transition: transform .14s ease, background .14s ease;
}
.tooth:hover { background: var(--theme--background-subdued, #f3f5f6); }
.tooth:hover .glyph { transform: translateY(-2px); }
.tooth.selected { background: var(--theme--primary-background, #e8f4f2); }
.tooth.selected .glyph { transform: translateY(-3px); }
/* A marker bar rather than a box outline: reads as a chart annotation. */
.tooth.selected::after {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: 2px; height: 2px;
  border-radius: 2px; background: var(--theme--primary, #0d6e63);
}
.tooth:focus-visible { outline: 2px solid var(--theme--primary, #0d6e63); outline-offset: 1px; }
.glyph { width: 100%; height: 34px; display: block; transition: transform .14s ease; }
.fdi {
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  font-size: 10px; color: var(--theme--foreground-subdued, #7a8b99); font-variant-numeric: tabular-nums;
}

.midline { height: 1px; background: var(--line); margin: 14px 0; }

.legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--theme--foreground-subdued, #7a8b99); }
.legend-item i { width: 11px; height: 11px; border-radius: 3px; border: 1px solid; display: inline-block; }
.legend-item i.absent { border-style: dashed; position: relative; }
.legend-item i.absent::after {
  content: ""; position: absolute; inset: -1px; border-radius: 3px;
  background: linear-gradient(to bottom right, transparent 44%, currentColor 44%, currentColor 56%, transparent 56%);
  opacity: .75;
}

.detail { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.detail-head { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.pill { border: 1px solid; border-radius: 99px; padding: 2px 9px; font-size: 11px; font-weight: 600; }
.history { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.history li { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.when { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 11.5px; color: var(--theme--foreground-subdued, #7a8b99); min-width: 92px; }
.surface { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 11px; color: var(--theme--foreground-subdued, #7a8b99); }
.notes { color: var(--theme--foreground-subdued, #7a8b99); }
</style>
