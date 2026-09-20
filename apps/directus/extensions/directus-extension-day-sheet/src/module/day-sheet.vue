<script setup lang="ts">
import { EnamelState, installEnamelUi } from "@enamel/extension-ui";
/**
 * The day sheet.
 *
 * Chairs across the top, time down the side. This is the view a practice
 * actually works from, and it is the one thing Directus cannot be
 * configured into: its calendar layout does day, week and month by time,
 * with no notion of a resource lane. A dental diary is read by chair —
 * "what is surgery 2 doing at eleven" — and a layout that cannot express
 * that is a layout nobody at the front desk will use.
 *
 * It has to look like a diary, which took a second attempt. The first drew
 * each chair as a bordered, rounded, filled card with a gap beside it —
 * which is a kanban board. A diary is one continuous grid: hairline rules,
 * columns that touch, and the only radius on the outside edge.
 *
 * Nothing that comes and goes is in the flow. The toast, the loading bar
 * and the closed-day notice all overlay, because a message that pushes the
 * grid down moves the appointment out from under the pointer dragging it.
 *
 * The grid is absolute positioning over a fixed pixel-per-minute scale,
 * not a table. A table would make a 45-minute appointment occupy three
 * 15-minute rows and a 50-minute one impossible to draw.
 *
 * This file is the template and the look. The day's data and everything
 * derived from it live in `use-day-sheet`, dragging lives in
 * `use-day-drag`, and the timezone arithmetic in `time`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useApi, useStores } from "@directus/extensions-sdk";
import { isMovable } from "./types";
import { localMinutesNow } from "@enamel/time";
import { useDaySheet, HEAD } from "./use-day-sheet";
import { useDayDrag } from "./use-day-drag";

const api = useApi();
const state = useDaySheet(api);
const {
  today, date, sheet, loading, loadFailure, flash,
  shiftDay, goToday,
  opensAt, closesAt, height, weekday, gridlines, scale, room,
  byRoom, unassigned, closedRooms, summary,
  blockStyle, showsMeta,
} = state;

/**
 * How much of the window the grid can have.
 *
 * Measured from where the grid actually starts rather than guessed from
 * the viewport: the toolbar wraps on a narrow window and the module bar
 * is a different height in Directus 11 and 12, so any constant here would
 * be wrong somewhere. `bottom` is the breathing room under the grid.
 *
 * Re-measured on resize and whenever the sheet changes. Measuring once
 * after mount is not enough and the failure is quiet: the first frame
 * runs before the sheet has loaded, so the toolbar is not in the document
 * yet, the stage's top reads near zero, and the grid is sized for a
 * window taller than the one it is in — it fits perfectly and hangs 100
 * pixels off the bottom. The watcher below is what makes the measurement
 * true rather than early.
 */
const stage = ref<HTMLElement | null>(null);
const BOTTOM = 24;
function measure(): void {
  const el = stage.value;
  if (!el) return;
  room.value = Math.max(0, window.innerHeight - el.getBoundingClientRect().top - BOTTOM);
}
const { dragging, hovering, onDragStart, onDragOver, onDrop, onDragEnd, clockOf } =
  useDayDrag(api, state);

/**
 * Where "now" sits, for the line across today.
 *
 * Every real diary draws it, and it is the fastest way to read a day:
 * everything above the line has happened. Ticks each minute — at 1.4
 * pixels per minute a second is not a distance.
 */
const nowMinute = ref<number | null>(null);
let ticker: ReturnType<typeof setInterval> | null = null;

function retick(): void {
  const tz = sheet.value?.practice.timezone;
  nowMinute.value = tz && sheet.value?.date === today ? localMinutesNow(tz) : null;
}
/*
 * Feedback goes through Directus's own notifications, not a toast of ours.
 *
 * The day sheet used to float its own panel over the grid. It worked, and
 * it was wrong in two ways: it looked like this extension rather than like
 * the admin it lives in, and it covered the column headers it happened to
 * sit over — a confirmation is not worth hiding "Hygiene room" behind.
 * Directus already has somewhere for this, in the instance's own styling
 * and out of the way of the content.
 *
 * The composable still raises a plain `{ text, bad }` and knows nothing
 * about stores, which keeps the grid maths testable without a Directus
 * runtime. This watcher is the only part that knows where a message goes,
 * and it clears the flag so the same message can be raised twice.
 */
const { useNotificationsStore } = useStores();
const notifications = useNotificationsStore();
watch(flash, (f) => {
  if (!f) return;
  notifications.add({
    title: f.text,
    type: f.bad ? "error" : "success",
    // A refusal is a sentence somebody has to act on; a confirmation is
    // not, and should not need dismissing.
    persist: f.bad,
    closeable: true,
  });
  flash.value = null;
});

/* After the sheet renders, not before: the toolbar's height is only known
   once it has something to say about the day. `flush: "post"` waits for
   the DOM, and the nextTick guards the case where a wrapped toolbar
   changes height in the same frame. */
watch(sheet, async () => {
  await nextTick();
  measure();
}, { flush: "post" });

onMounted(() => {
  retick();
  ticker = setInterval(retick, 60_000);
  measure();
  window.addEventListener("resize", measure);
});
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
  window.removeEventListener("resize", measure);
});

// One shared set of states across every Enamel extension. See the note
// on @enamel/extension-ui — this exists because this module and the
// practice report rendered the same refusal two different ways.
installEnamelUi();

/**
 * "Day sheet", and the practice's name only once there is one.
 *
 * This was a template literal with an em dash in it, which rendered
 * `Day sheet — ` with nothing after the separator on every load before
 * the first response, and on every failure. A separator with one side
 * missing is always a bug.
 */
const title = computed(() =>
  sheet.value?.practice?.name ? `Day sheet — ${sheet.value.practice.name}` : "Day sheet",
);

const nowVisible = computed(
  () =>
    nowMinute.value !== null &&
    nowMinute.value >= opensAt.value &&
    nowMinute.value <= closesAt.value,
);

/** `interface-datetime` hands back an ISO string; the sheet wants the date half. */
function onDateInput(value: string | null): void {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    date.value = value.slice(0, 10);
  }
}
</script>

<template>
  <private-view :title="title">
    <template #navigation>
      <div class="ds-nav">
        <p class="ds-nav-hint">
          The diary by chair. Drag an appointment to move it — the practice's own
          rules answer, and say why when they refuse.
        </p>
        <dl v-if="sheet" class="ds-stats">
          <div><dt>Booked</dt><dd>{{ summary.booked }}</dd></div>
          <div><dt>Seen</dt><dd>{{ summary.done }}</dd></div>
          <div><dt>Did not attend</dt><dd>{{ summary.missed }}</dd></div>
          <div><dt>Chairs in use</dt><dd>{{ summary.chairs }} of {{ sheet.rooms.length }}</dd></div>
        </dl>
        <ul v-if="closedRooms.length || (sheet?.away ?? []).length" class="ds-flags">
          <li v-for="room in closedRooms" :key="room.id">
            <v-icon name="build" small />
            <span>{{ room.name }} out of service — {{ room.closed_reason?.replace(/_/g, " ") }}</span>
          </li>
          <li v-for="(a, i) in sheet?.away ?? []" :key="`away-${i}`">
            <v-icon name="event_busy" small />
            <span>{{ a.practitioner_name }} away — {{ a.kind.replace(/_/g, " ") }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div class="ds">
      <!-- Date navigation lives here rather than in the header actions:
           those render as circular icon buttons, and a text button among
           them comes out an oval. -->
      <div class="ds-bar">
        <div class="ds-date">
          <interface-datetime type="date" :value="date" @input="onDateInput" />
        </div>

        <div class="ds-nudge">
          <v-button secondary icon v-tooltip.bottom="'Previous day'" @click="shiftDay(-1)">
            <v-icon name="chevron_left" />
          </v-button>
          <v-button secondary :disabled="date === today" @click="goToday()">Today</v-button>
          <v-button secondary icon v-tooltip.bottom="'Next day'" @click="shiftDay(1)">
            <v-icon name="chevron_right" />
          </v-button>
        </div>

        <p v-if="sheet" class="ds-when">
          <strong>{{ weekday }}</strong>
          <template v-if="sheet.open"> · {{ sheet.opens_at }}–{{ sheet.closes_at }}</template>
          <template v-else> · closed</template>
          <span class="ds-tz">{{ sheet.practice.timezone }}</span>
        </p>
      </div>

      <div class="ds-stage" ref="stage">
        <!-- Feedback on the last drag, not on the state of the page. A
             refused move still leaves a correct grid behind it, so the
             message floats over the grid rather than replacing it. A
             failure to *load* is a different thing and is below. -->
        <!-- The day could not be loaded. Same component, same wording and
             same placement as every other extension in this repo. -->
        <EnamelState v-if="loadFailure || (loading && !sheet)" :loading="loading && !sheet"
                     :error="loadFailure" fill />

        <!-- Only on a refresh. The first load has no grid behind it and
             gets the shared loading panel instead, so the module does not
             sit blank while it fetches. -->
        <v-progress-linear v-if="loading && sheet" class="ds-loading" indeterminate />

        <!--
          A closed day is a condition, not an error, and it is drawn by the
          same component as every other condition in the admin.

          It used to be Directus's own `v-info`, which renders its body in
          `--theme--foreground-subdued` — the token that measures 2.68:1 and
          must never carry text. Here it came out at 3.01:1 against the day
          sheet's ground, under the 4.5:1 that 13px body text needs. It
          survived because the branch only renders on a day the practice is
          shut, so the probe that would have caught it only sees this one
          day in seven.
        -->
        <EnamelState
          v-if="sheet && !sheet.open"
          :refusal="{
            kind: 'condition',
            title: `Closed on a ${weekday}`,
            body: 'The practice is not open, so nothing can be booked.',
          }"
          fill
        />

        <div
          v-else-if="sheet"
          class="ds-grid"
          :style="{ height: `${height + HEAD}px`, '--ds-head': `${HEAD}px` }"
        >
          <div class="ds-gutter">
            <div class="ds-corner" />
            <div class="ds-gutter-body">
              <div
                v-for="line in gridlines"
                :key="line.minute"
                class="ds-tick"
                :style="{ top: `${(line.minute - opensAt) * scale}px` }"
              >
                <span v-if="line.major">{{ line.label }}</span>
              </div>
            </div>
          </div>

          <div
            v-for="room in sheet.rooms"
            :key="room.id"
            class="ds-col"
            :class="{ down: room.closed, target: hovering?.room === room.id }"
          >
            <div class="ds-col-head">
              <span class="ds-col-name">{{ room.name }}</span>
              <span v-if="room.chair_number" class="ds-col-sub">chair {{ room.chair_number }}</span>
            </div>

            <!-- The drop target is the body, not the column: a drop on the
                 header resolves to a negative minute and would book
                 somebody in before the practice opened. -->
            <div
              class="ds-col-body"
              @dragover="onDragOver(room.id, $event)"
              @drop="onDrop(room.id, $event)"
              @dragleave="hovering = null"
            >
              <div
                v-for="line in gridlines"
                :key="line.minute"
                class="ds-rule"
                :class="{ major: line.major }"
                :style="{ top: `${(line.minute - opensAt) * scale}px` }"
              />

              <div
                v-if="nowVisible"
                class="ds-now"
                :style="{ top: `${(nowMinute! - opensAt) * scale}px` }"
              />

              <div
                v-if="hovering?.room === room.id"
                class="ds-ghost"
                :style="{ top: `${(hovering.minute - opensAt) * scale}px` }"
              >
                <span class="ds-ghost-time">{{ clockOf(hovering.minute) }}</span>
              </div>

              <article
                v-for="a in byRoom[room.id] ?? []"
                :key="a.id"
                class="ds-appt"
                :class="[a.status, { moving: dragging?.id === a.id }]"
                :style="blockStyle(a)"
                :draggable="isMovable(a)"
                @dragstart="onDragStart(a, $event)"
                @dragend="onDragEnd()"
              >
                <span class="ds-appt-when">{{ a.local_start }}–{{ a.local_end }}</span>
                <span class="ds-appt-who">{{ a.patient_name }}</span>
                <span v-if="showsMeta(a)" class="ds-appt-meta">
                  {{ a.practitioner_name }}<template v-if="a.reason"> · {{ a.reason }}</template>
                </span>
              </article>
            </div>
          </div>

          <div
            v-if="unassigned.length"
            class="ds-col unplaced"
            :class="{ target: hovering?.room === 'unassigned' }"
          >
            <div class="ds-col-head">
              <span class="ds-col-name">No chair yet</span>
            </div>
            <div
              class="ds-col-body"
              @dragover="onDragOver('unassigned', $event)"
              @drop="onDrop('unassigned', $event)"
              @dragleave="hovering = null"
            >
              <article
                v-for="a in unassigned"
                :key="a.id"
                class="ds-appt"
                :class="a.status"
                :style="blockStyle(a)"
                :draggable="isMovable(a)"
                @dragstart="onDragStart(a, $event)"
                @dragend="onDragEnd()"
              >
                <span class="ds-appt-when">{{ a.local_start }}–{{ a.local_end }}</span>
                <span class="ds-appt-who">{{ a.patient_name }}</span>
              </article>
            </div>
          </div>
        </div>
      </div>
    </div>
  </private-view>
</template>

<style scoped>
/**
 * Directus's theme variables, mapped once.
 *
 * Getting these wrong is silent and ugly. `--theme--background-page` does
 * not exist — it is `--theme--background` — so a fallback of `#fff`
 * painted every appointment white on a dark theme, under light text. The
 * legacy `--background-page` / `--foreground-normal` names are gone in 11
 * too, so a `var(--theme--x, var(--legacy))` chain fell through to
 * nothing and the declaration was simply dropped.
 *
 * One place to be wrong, and literal fallbacks that are at least legible
 * rather than a second undefined name.
 */
.ds {
  --ds-bg: var(--theme--background, #12181c);
  --ds-bg-soft: var(--theme--background-subdued, #161b22);
  --ds-fg: var(--theme--foreground, #dee4e8);
  /*
   * Not --theme--foreground-subdued.
   *
   * Measured: that token is 2.68:1 on this admin's surfaces, under the
   * 4.5:1 WCAG asks for body text, and it was the secondary tone in every
   * extension here — 109 failing text elements between them. It looks like
   * the right token and it cannot be used for text.
   *
   * The secondary tone is mixed from the *readable* foreground instead:
   * secondary enough to recede, close enough to read, and it follows
   * whichever theme the admin is in because both ends are theme tokens.
   * The subdued token is still right for what it was named for — borders
   * and icons, things that are not read. Same reasoning and same mix as
   * --en-ink-dim in @enamel/extension-ui.
   */
  --ds-fg-soft: color-mix(in srgb, var(--theme--foreground, #4f5464) 80%, var(--theme--background, #f0f4f9));
  --ds-line: var(--theme--border-color-subdued, #21262d);
  --ds-line-strong: var(--theme--border-color, #21262e);
  --ds-accent: var(--theme--primary, #73b8e8);
  --ds-accent-bg: var(--theme--primary-background, #162c3b);
  --ds-danger: var(--ds-danger);
  --ds-radius: var(--theme--border-radius, 5px);

  padding: 0 var(--content-padding, 32px) var(--content-padding, 32px);
}

/* ---------- toolbar ---------- */

.ds-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
/* interface-datetime is a full-width form field; in a toolbar it needs a
   width or it takes the whole row.
   
   Wide enough for the longest date this renders — "September 20th, 2026"
   is 19 characters and was close enough to the clear button to look
   cramped. */
.ds-date { width: 300px; }

/* One height across the toolbar, and it is the taller one.
 *
 * `interface-datetime` renders a `v-list-item` — a row in a menu, sized
 * like one at 54px — beside `small` buttons at 32px, so the date sat 22px
 * proud of the controls it belongs with.
 *
 * Levelled by raising the buttons rather than shrinking the field. The
 * date is the control people reach for on this screen and the one that
 * has to stay easy to hit; taking 22px off it to match a chevron is
 * solving the alignment at the expense of the thing the toolbar is for.
 * It also keeps the field the size Directus gives a date input everywhere
 * else in the admin.
 *
 * `--v-button-height` is the variable Directus sizes a button from, and
 * it has to be set on the inner `button` as well as the wrapper: the
 * `small` class redefines the variable *on the element itself*, so a
 * value inherited from the wrapper never reaches it. The prop is gone
 * from the markup too — these are not small buttons any more, and saying
 * so beats overriding it. `:deep()` because these elements belong to
 * child components and scoped styles do not reach them. */
/* The stepper wears the practice's colour, taken from the theme.
 *
 * It was Directus's `secondary` grey, which is correct for a button that
 * sits beside a primary one and wrong for the only controls on this
 * toolbar — nothing about them said which product they belonged to.
 *
 * Solid rather than tinted, and that was measured rather than chosen:
 * `--theme--primary-background` behind accent text reads nicely at 6.69:1
 * for the label, but the control itself is only 1.24:1 against the page,
 * under the 3:1 WCAG asks of a UI boundary — a button you cannot see the
 * edge of. Solid accent is 8.31:1 both for the glyph on the button and
 * for the button on the page.
 *
 * Every colour is a theme variable, so a change of brand colour moves
 * these with it and there is no hex here to go stale. */
.ds-nudge :deep(.v-button),
.ds-nudge :deep(.v-button button) {
  --v-button-height: 54px;
  --v-button-background-color: var(--theme--primary);
  --v-button-color: var(--theme--background);
  --v-button-background-color-hover: var(--theme--primary-accent, var(--theme--primary));
  --v-button-color-hover: var(--theme--background);
  /* Disabled is "Today, when you are already on today" — still legible,
     visibly not pressable. */
  --v-button-background-color-disabled: var(--theme--primary-background);
  --v-button-color-disabled: var(--theme--primary);
}
.ds-nudge :deep(.v-button.icon button) { width: 44px; }
.ds-nudge :deep(.v-button:not(:first-child) button) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.ds-nudge :deep(.v-button:not(:last-child) button) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: 1px solid color-mix(in srgb, var(--theme--background) 32%, transparent);
}
/* Previous / Today / Next, joined into one control.
 *
 * Three separate buttons at the toolbar's height came out as three heavy
 * 54px slabs that read louder than the date they exist to nudge. They are
 * one thing — a date stepper — so they are drawn as one: no gaps, square
 * edges on the joins, rounded only at the ends, and the chevrons narrower
 * than they are tall, because a 54px square around a chevron is all box
 * and no arrow.
 *
 * The hairlines between segments are a darkened slice of the accent, not
 * a gap. A gap let the page show through, which on a grey stepper was an
 * invisible seam and on a solid accent one reads as a crack straight
 * through the control. Mixed from the background so it tracks the theme
 * like everything else here. */
.ds-nudge { display: flex; align-items: center; gap: 0; }

.ds-when {
  margin: 0;
  color: var(--ds-fg-soft);
}
.ds-when strong { color: var(--ds-fg); font-weight: 600; }
.ds-tz { margin-left: 10px; font-size: 12px; opacity: 0.7; }

/* ---------- the stage, where nothing reflows ---------- */

.ds-stage { position: relative; }

.ds-loading { position: absolute; top: -6px; left: 0; right: 0; z-index: 6; }

/* ---------- the diary ---------- */

.ds-grid {
  display: flex;
  overflow: auto;
  /* One border round the whole thing, and the only radius in the grid.
     Per-column borders, radii and gaps are what made this read as a
     kanban board rather than a day sheet. */
  border: 1px solid var(--ds-line);
  border-radius: var(--ds-radius);
  background: var(--ds-bg);
}

.ds-gutter {
  position: sticky;
  left: 0;
  z-index: 4;
  flex: 0 0 60px;
  display: flex;
  flex-direction: column;
  background: var(--ds-bg);
  border-right: 1px solid var(--ds-line);
}
.ds-corner {
  height: var(--ds-head);
  border-bottom: 1px solid var(--ds-line);
  background: var(--ds-bg-soft);
}
.ds-gutter-body { position: relative; flex: 1 1 auto; }
.ds-tick {
  position: absolute;
  right: 8px;
  transform: translateY(-50%);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ds-fg-soft);
}

.ds-col {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 200px;
}
.ds-col + .ds-col {
  border-left: 1px solid var(--ds-line);
}
.ds-col.down .ds-col-body {
  background: repeating-linear-gradient(
    45deg,
    transparent 0 7px,
    var(--ds-line) 7px 8px
  );
}
.ds-col.target .ds-col-body {
  background-color: color-mix(in srgb, var(--ds-accent) 8%, transparent);
}
.ds-col.unplaced { flex: 0 0 200px; }

.ds-col-head {
  height: var(--ds-head);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 12px;
  background: var(--ds-bg-soft);
  border-bottom: 1px solid var(--ds-line);
  position: sticky;
  top: 0;
  z-index: 3;
}
.ds-col-name { font-weight: 600; font-size: 13px; }
.ds-col-sub {
  font-size: 11px;
  color: var(--ds-fg-soft);
}

.ds-col-body { position: relative; flex: 1 1 auto; }
.ds-gutter-body,
.ds-col-body { padding-bottom: 10px; }

.ds-rule {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px solid var(--ds-line);
  opacity: 0.28;
}
.ds-rule.major { opacity: 0.75; }

/* Everything above this has happened. Every real diary draws it. */
.ds-now {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  border-top: 2px solid var(--ds-danger);
  pointer-events: none;
}
.ds-now::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ds-danger);
}

.ds-ghost {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 5;
  border-top: 2px dashed var(--ds-accent);
  pointer-events: none;
}
.ds-ghost-time {
  position: absolute;
  top: -17px;
  left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ds-bg);
  background: var(--ds-accent);
}

.ds-appt {
  position: absolute;
  left: 3px;
  right: 3px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
  padding: 3px 8px;
  /* Square-ish. A diary block is a span of time, and a pill does not read
     as one. */
  border-radius: 3px;
  border-left: 3px solid var(--ds-accent);
  background: var(--ds-accent-bg);
  color: var(--ds-fg);
  cursor: grab;
}
.ds-appt.moving { opacity: 0.35; cursor: grabbing; }
.ds-appt.confirmed { border-left-color: #2ecda7; }
.ds-appt.completed {
  border-left-color: #7a8b99;
  background: color-mix(in srgb, #7a8b99 22%, transparent);
  cursor: default;
}
.ds-appt.cancelled {
  border-left-color: #a2b5cd;
  background: transparent;
  border: 1px dashed var(--ds-line-strong);
  border-left: 3px solid #a2b5cd;
  cursor: default;
}
.ds-appt.cancelled .ds-appt-who { text-decoration: line-through; }
.ds-appt.no_show {
  border-left-color: #e35169;
  background: color-mix(in srgb, var(--ds-danger) 18%, transparent);
  cursor: default;
}

.ds-appt-when {
  font-size: 11px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--ds-fg-soft);
}
.ds-appt-who {
  font-weight: 600;
  font-size: 13px;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ds-appt-meta {
  font-size: 11px;
  line-height: 1.2;
  color: var(--ds-fg-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- module sidebar ---------- */

.ds-nav { padding: 12px 16px; }
.ds-nav-hint {
  margin: 0;
  color: var(--ds-fg-soft);
  font-size: 13px;
  line-height: 1.5;
}
.ds-stats { margin: 20px 0 0; display: flex; flex-direction: column; gap: 10px; }
.ds-stats > div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.ds-stats dt { color: var(--ds-fg-soft); font-size: 13px; }
.ds-stats dd { margin: 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

.ds-flags {
  margin: 20px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ds-flags li {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ds-fg-soft);
}
</style>
