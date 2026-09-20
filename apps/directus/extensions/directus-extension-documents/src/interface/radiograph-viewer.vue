<script setup lang="ts">
/**
 * Reading a radiograph on a screen.
 *
 * Directus shows an uploaded image as a thumbnail with a lightbox. That
 * is right for a logo and wrong for a bitewing: the first thing anybody
 * does with a radiograph is make it bigger, then brighter, then darker,
 * then inverted — because a shade of grey that hides an interproximal
 * lesion at one exposure shows it at another. A viewer without those
 * controls is a viewer nobody uses, and the work goes back to exporting
 * the file and opening it in something else, which is how images escape
 * the records system.
 *
 * Two things this deliberately is not.
 *
 * It is not diagnostic-grade. A diagnostic display is a calibrated
 * monitor at a known luminance, and no amount of web code makes a laptop
 * one. The banner says so, because a viewer that quietly implies it is
 * fit for diagnosis is worse than one that admits it is not.
 *
 * And it is not destructive. Every adjustment is a CSS filter on the way
 * to the screen. The stored file is never re-encoded, never overwritten,
 * and nothing here can write to it — an "enhance and save" button on a
 * clinical image is a records-integrity problem wearing a feature's
 * clothes, because the version the practice later relies on is then not
 * the version the sensor produced.
 */
import { computed, ref, watch } from "vue";
import { EnamelState, installEnamelUi, type Refusal } from "@enamel/extension-ui";

const props = withDefaults(
  defineProps<{
    value?: string | null;
    disabled?: boolean;
    invertByDefault?: boolean;
    collection?: string;
    field?: string;
    primaryKey?: string | number | null;
  }>(),
  { value: null, disabled: false, invertByDefault: false },
);

const emit = defineEmits<{ (e: "input", value: string | null): void }>();

type FileInfo = {
  id: string;
  title: string | null;
  type: string | null;
  filesize: number | null;
  width: number | null;
  height: number | null;
  uploaded_on: string | null;
};

const file = ref<FileInfo | null>(null);
const loading = ref(false);

/**
 * Why there is nothing to show, when there is nothing to show.
 *
 * A file the caller cannot read is the permission model working, not a
 * failure — so it is a `condition`, in grey, like every other refusal in
 * this repo. It used to be an orange warning, which reads as "something
 * is wrong with the file".
 */
const refusal = ref<Refusal | null>(null);

installEnamelUi();

/* ---------------- adjustments ---------------- */

const brightness = ref(100);
const contrast = ref(100);
const inverted = ref(props.invertByDefault);
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);

const adjusted = computed(
  () =>
    brightness.value !== 100 ||
    contrast.value !== 100 ||
    inverted.value !== props.invertByDefault,
);

function reset(): void {
  brightness.value = 100;
  contrast.value = 100;
  inverted.value = props.invertByDefault;
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
}

const filters = computed(
  () =>
    `brightness(${brightness.value}%) contrast(${contrast.value}%)` +
    (inverted.value ? " invert(1)" : ""),
);

const transform = computed(
  () => `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`,
);

/* ---------------- pan ---------------- */

// Pointer events rather than mouse events: the same three handlers then
// work for a trackpad, a mouse and a finger, and a dentist looking at a
// radiograph on an iPad at the chair is not an edge case.
const dragging = ref(false);
let originX = 0;
let originY = 0;

function startPan(e: PointerEvent): void {
  if (zoom.value === 1) return;
  dragging.value = true;
  originX = e.clientX - panX.value;
  originY = e.clientY - panY.value;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function movePan(e: PointerEvent): void {
  if (!dragging.value) return;
  panX.value = e.clientX - originX;
  panY.value = e.clientY - originY;
}

function endPan(e: PointerEvent): void {
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
}

function wheelZoom(e: WheelEvent): void {
  e.preventDefault();
  const next = zoom.value * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
  zoom.value = Math.min(8, Math.max(1, Number(next.toFixed(3))));
  if (zoom.value === 1) {
    panX.value = 0;
    panY.value = 0;
  }
}

/* ---------------- the file ---------------- */

const assetUrl = computed(() => (props.value ? `/assets/${props.value}` : null));

const isImage = computed(() => (file.value?.type ?? "").startsWith("image/"));
const isDicom = computed(() => {
  const type = file.value?.type ?? "";
  const name = file.value?.title ?? "";
  return type === "application/dicom" || /\.dcm$/i.test(name);
});

const sizeLabel = computed(() => {
  const bytes = file.value?.filesize;
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
});

async function load(): Promise<void> {
  if (!props.value) {
    file.value = null;
    return;
  }
  loading.value = true;
  refusal.value = null;
  try {
    const res = await fetch(
      `/files/${props.value}?fields=id,title,type,filesize,width,height,uploaded_on`,
      { credentials: "same-origin" },
    );
    if (!res.ok) throw new Error(String(res.status));
    file.value = (await res.json()).data as FileInfo;
  } catch {
    // Say which, because "nothing happened" is how a deliberate refusal
    // gets reported as a bug.
    refusal.value = {
      kind: "condition",
      title: "This file is not available to you",
      body: "Radiographs and clinical photographs are open to clinicians only.",
    };
    file.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.value, load, { immediate: true });
watch(() => props.invertByDefault, reset);

function clear(): void {
  emit("input", null);
}
</script>

<template>
  <div class="rv">
    <EnamelState
      v-if="!value || loading || refusal"
      :loading="loading"
      loading-label="Opening the image…"
      :refusal="refusal"
      :empty="!value && !loading && !refusal"
      empty-title="No file attached yet"
      empty-body="Attach a radiograph, photograph or letter to this record."
    />

    <template v-else>
      <div class="rv__bar">
        <div class="rv__what">
          <span class="rv__name">{{ file?.title || "Untitled" }}</span>
          <span class="rv__meta">
            {{ file?.width && file?.height ? `${file.width}×${file.height}` : file?.type }}
            <template v-if="sizeLabel"> · {{ sizeLabel }}</template>
          </span>
        </div>
        <div class="rv__actions">
          <v-button v-tooltip="'Open the original'" x-small secondary :href="assetUrl" target="_blank">
            <v-icon name="open_in_new" small />
          </v-button>
          <v-button v-if="!disabled" v-tooltip="'Detach'" x-small secondary @click="clear">
            <v-icon name="link_off" small />
          </v-button>
        </div>
      </div>

      <!--
        DICOM gets an honest refusal rather than a broken <img>.

        Two reasons, and the second is the one that settles it. The
        technical one is real — transfer-syntax codecs, window/level from
        the study's own tags, a calibrated display. The regulatory one is
        that software intended to present an image *for diagnosis* is a
        medical device under EU Regulation 2017/745, and Rule 11 of
        Annex VIII puts diagnostic imaging software in Class IIa at the
        least: a notified body, a clinical evaluation, ISO 13485 and
        post-market surveillance. A practice management system that
        rendered a radiograph for reading would be claiming exactly that.
      -->
      <div v-if="isDicom" class="rv__dicom">
        <v-icon name="medical_information" large />
        <p class="rv__dicom-title">A DICOM study, stored but not rendered here</p>
        <p class="rv__dicom-body">
          The file is kept intact and can be downloaded for a workstation that reads it.
          Drawing the pixels here would need the transfer-syntax codecs and the
          window/level values from the study's own tags — and it would make this
          software a medical device: under EU Regulation 2017/745, Annex VIII Rule 11,
          imaging software intended for diagnosis is Class IIa. That is a notified body
          and a clinical evaluation, not a feature.
        </p>
        <p class="rv__dicom-body rv__dicom-quiet">
          Storing, archiving and displaying a study for reference is not. The line is
          what the software is <em>intended</em> for, which is why this panel says so.
        </p>
      </div>

      <EnamelState
        v-else-if="!isImage"
        empty
        :empty-title="file?.type || 'A file'"
        empty-body="Not an image — open it to read it."
      />

      <template v-else>
        <div
          class="rv__stage"
          :class="{ 'rv__stage--grab': zoom > 1, 'rv__stage--grabbing': dragging }"
          @wheel="wheelZoom"
          @pointerdown="startPan"
          @pointermove="movePan"
          @pointerup="endPan"
          @pointercancel="endPan"
        >
          <img
            class="rv__image"
            :src="assetUrl ?? ''"
            :alt="file?.title ?? 'Radiograph'"
            :style="{ filter: filters, transform }"
            draggable="false"
          />
          <div v-if="adjusted" class="rv__flag">
            Adjusted for viewing — the stored image is unchanged
          </div>
        </div>

        <div class="rv__controls">
          <label class="rv__control">
            <span>Brightness</span>
            <input v-model.number="brightness" type="range" min="20" max="220" step="1" />
            <output>{{ brightness }}%</output>
          </label>
          <label class="rv__control">
            <span>Contrast</span>
            <input v-model.number="contrast" type="range" min="20" max="300" step="1" />
            <output>{{ contrast }}%</output>
          </label>
          <label class="rv__control">
            <span>Zoom</span>
            <input v-model.number="zoom" type="range" min="1" max="8" step="0.1" />
            <output>{{ zoom.toFixed(1) }}×</output>
          </label>
          <div class="rv__toggles">
            <v-button x-small :secondary="!inverted" @click="inverted = !inverted">
              <v-icon name="invert_colors" small />
              Invert
            </v-button>
            <v-button x-small secondary :disabled="!adjusted && zoom === 1" @click="reset">
              Reset
            </v-button>
          </div>
        </div>

        <p class="rv__disclaimer">
          For review on this screen only. Diagnosis from a radiograph needs a calibrated
          display; nothing here changes the file on record.
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
/*
 * Theme variables, mapped once at the root of this component.
 *
 * `--theme--background-page` does not exist and silently resolves to
 * nothing, which paints white blocks under light text in dark mode. The
 * names below are the real ones.
 */
.rv {
  --rv-bg: var(--theme--background, #f0f4f9);
  --rv-surface: var(--theme--background-normal, #e4eaf1);
  --rv-line: var(--theme--border-color, #d3dae4);
  --rv-text: var(--theme--foreground, #4f5464);
  /*
   * Derived, not taken.
   *
   * Directus's own `--theme--foreground-subdued` measures **2.68:1** on
   * `--theme--background-normal` in this admin — under the 4.5:1 WCAG
   * asks for body text — and every extension here was using it for slider
   * labels, metadata lines and hints. It looks like the right token and
   * it is not usable for text.
   *
   * So the secondary tone is mixed from the *readable* foreground rather
   * than inherited from the subdued one: far enough toward the background
   * to read as secondary, close enough to stay legible, and it follows
   * whichever theme the admin is in because both ends are theme tokens.
   * The subdued token is still right for what it was named for — borders,
   * icons, things that are not read.
   */
  --rv-dim: color-mix(in srgb, var(--theme--foreground, #4f5464) 80%, var(--theme--background, #f0f4f9));
  --rv-accent: var(--theme--primary, #73b8e8);

  border: var(--theme--border-width, 2px) solid var(--rv-line);
  border-radius: var(--theme--border-radius, 6px);
  background: var(--rv-bg);
  overflow: hidden;
}

.rv__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  color: var(--rv-dim);
  font-size: 14px;
}
.rv__empty--refused { color: var(--theme--warning, #ffa439); }

.rv__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--rv-line);
  background: var(--rv-surface);
}
.rv__what { min-width: 0; }
.rv__name {
  display: block;
  font-weight: 600;
  font-size: 14px;
  color: var(--rv-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv__meta { font-size: 12px; color: var(--rv-dim); }
.rv__actions { display: flex; gap: 6px; flex: 0 0 auto; }

/* Black, not the page colour: a radiograph read against a light surround
   is a radiograph read badly, and every viewer in the field uses black
   for the same reason. */
.rv__stage {
  position: relative;
  overflow: hidden;
  background: #000;
  min-height: 240px;
  max-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}
.rv__stage--grab { cursor: grab; }
.rv__stage--grabbing { cursor: grabbing; }

.rv__image {
  max-width: 100%;
  max-height: 60vh;
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
  will-change: transform, filter;
}

.rv__flag {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.72);
  color: #ffd479;
  font-size: 11px;
  letter-spacing: 0.02em;
  pointer-events: none;
}

.rv__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid var(--rv-line);
  background: var(--rv-surface);
}
.rv__control {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--rv-dim);
  flex: 1 1 190px;
}
.rv__control span { flex: 0 0 auto; }
.rv__control input { flex: 1 1 auto; accent-color: var(--rv-accent); min-width: 80px; }
.rv__control output {
  flex: 0 0 42px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--rv-text);
}
.rv__toggles { display: flex; gap: 6px; flex: 0 0 auto; }

/*
 * `--rv-text`, not `--rv-dim`, and no opacity on the second paragraph.
 *
 * Measured rather than judged: Directus's own `foreground-subdued` on its
 * page background is **3.01:1** here, under the 4.5:1 WCAG asks for
 * body text — and a paragraph of it at 0.75 opacity came out at 2.25:1.
 * Both looked perfectly readable, which is the entire reason contrast is
 * computed in this project instead of eyeballed.
 *
 * This panel is the one that states a regulatory position. Demoting the
 * second half by making it fainter was the wrong instrument anyway; it is
 * demoted by being second, and by a rule above it.
 */
.rv__dicom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 24px;
  text-align: center;
  color: var(--rv-text);
}
.rv__dicom-title { margin: 0; font-weight: 600; color: var(--rv-text); }
.rv__dicom-quiet {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--rv-line);
  max-width: 52ch;
}
.rv__dicom-body { margin: 0; max-width: 52ch; font-size: 13px; line-height: 1.5; }

.rv__disclaimer {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--rv-line);
  font-size: 11px;
  /* Was `--rv-dim` at 3.01:1. The disclaimer is the one line that must be
     readable by whoever is about to disagree with it. */
  color: var(--rv-text);
  background: var(--rv-bg);
}
</style>
