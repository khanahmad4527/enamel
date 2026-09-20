<script setup lang="ts">
import { EnamelState, installEnamelUi } from "@enamel/extension-ui";
/**
 * The practice's numbers.
 *
 * Every figure here is a ratio, and that is the whole reason this is a
 * module rather than an Insights dashboard: a panel runs one aggregate
 * with a filter, and cannot divide one by another. The single-value
 * figures — invoiced revenue, outstanding balance, patient growth,
 * production over time — are panels, provisioned as a dashboard alongside
 * this. Nothing is reimplemented here that Directus already does.
 *
 * The arithmetic is all server-side, in the core service. A dashboard that
 * computes its own percentages in the browser is a second implementation
 * of the definitions, and the definitions are the hard part — what counts
 * as the denominator of a no-show rate is a decision, not a detail.
 */
import { computed, ref, watch } from "vue";
import { useApi } from "@directus/extensions-sdk";

type Summary = {
  range: { from: string; to: string };
  revenue: { invoiced: number; collected: number; outstanding: number; overdue: number; unpaidCount: number };
  production: { total: number; byDay: Array<{ day: string; value: number; items: number }> };
  attendance: {
    settled: number; completed: number; noShow: number; cancelled: number; upcoming: number;
    noShowRate: number | null; cancellationRate: number | null;
  };
  utilisation: {
    chair: { bookedMinutes: number; capacityMinutes: number; lostToClosures: number; rooms: number; rate: number | null };
    clinician: { bookedMinutes: number; capacityMinutes: number; lostToAbsence: number; rate: number | null };
  };
  acceptance: {
    plansPresented: number; plansAccepted: number;
    presentedValue: number; acceptedValue: number;
    itemsPresented: number; itemsAccepted: number;
    byValue: number | null; byCount: number | null;
  };
  recall: { due: number; scheduled: number; conversion: number | null };
  clinicians: Array<{ id: string; name: string; appointments: number; completed: number; noShow: number; production: number; bookedMinutes: number }>;
  growth: Array<{ month: string; joined: number }>;
};

const api = useApi();

// The shared states — error, condition, empty, loading — rendered the
// same way here as in every other extension. See the note on the package.
installEnamelUi();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const to = ref(iso(new Date()));
const from = ref(iso(new Date(Date.now() - 29 * 86_400_000)));

/** Which preset span is showing, so the buttons say which one is on. */
const activeSpan = ref(30);

const data = ref<Summary | null>(null);
const loading = ref(false);

/**
 * The failure itself, not a sentence extracted from it.
 *
 * This used to flatten the error to a string on the way in, which threw
 * away the status code — and the status code is what separates "the
 * service is down" from "you are signed in as an administrator, which
 * belongs to no practice". Both rendered identically, in red, as though
 * something had broken. See `refusalFrom` in @enamel/extension-ui.
 */
const failure = ref<unknown>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.get("/practice-report-api/summary", {
      params: { from: from.value, to: to.value },
    });
    data.value = res.data as Summary;
    failure.value = null;
  } catch (e: unknown) {
    failure.value = e;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch([from, to], load, { immediate: true });

/**
 * Is there anything in this period at all?
 *
 * A report that renders a full page of zeroes and empty bars looks
 * broken, and a reader cannot tell "nothing happened" from "the query is
 * wrong". Naming the condition is the difference.
 */
const hasAnything = computed(() => {
  const d = data.value;
  if (!d) return false;
  return (
    Number(d.revenue?.invoiced ?? 0) !== 0 ||
    Number(d.production?.total ?? 0) !== 0 ||
    Number(d.attendance?.settled ?? 0) !== 0 ||
    Number(d.attendance?.upcoming ?? 0) !== 0 ||
    (d.clinicians?.length ?? 0) > 0
  );
});

function span(days: number): void {
  activeSpan.value = days;
  to.value = iso(new Date());
  from.value = iso(new Date(Date.now() - (days - 1) * 86_400_000));
}

/** Null means "no denominator", which is not the same as zero. */
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

const money = (v: number): string =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(Math.round(v));

const hours = (minutes: number): string => `${Math.round(minutes / 60)}h`;

/**
 * The one comparison worth drawing attention to.
 *
 * A practice accepting 80% of items but 40% of value is one where patients
 * say yes to the fillings and no to the crowns. Either number alone tells
 * the wrong story half the time, so the gap gets its own line rather than
 * leaving a reader to subtract two percentages in their head.
 */
const acceptanceGap = computed(() => {
  const a = data.value?.acceptance;
  if (!a || a.byValue === null || a.byCount === null) return null;
  return a.byCount - a.byValue;
});

/** A bar chart needs a ceiling; an empty series must not divide by zero. */
const productionPeak = computed(() =>
  Math.max(1, ...(data.value?.production.byDay ?? []).map((d) => d.value)),
);
const growthPeak = computed(() =>
  Math.max(1, ...(data.value?.growth ?? []).map((g) => g.joined)),
);
</script>

<template>
  <private-view title="Practice report">
    <template #navigation>
      <div class="pr-nav">
        <p class="pr-hint">
          Rates, not totals. The single figures — invoiced revenue, outstanding
          balance, new patients — are Insights panels; these are the ones a
          panel cannot compute, because each is one number divided by another.
        </p>
        <p class="pr-hint pr-hint-quiet">
          Every figure is scoped to your practice, and comes from the core
          service rather than the browser: the definitions live in one place.
        </p>
      </div>
    </template>

    <div class="pr">
      <div class="pr-bar">
        <v-button v-for="d in [7, 30, 90]" :key="d" small
                  :secondary="activeSpan !== d" @click="span(d)">{{ d }} days</v-button>
        <span v-if="data" class="pr-range">{{ data.range.from }} → {{ data.range.to }}</span>
        <v-progress-circular v-if="loading" indeterminate small />
      </div>

      <EnamelState
        :loading="loading && !data"
        :error="failure"
        :empty="Boolean(data) && !hasAnything"
        empty-title="Nothing happened in this period"
        empty-body="No invoices were raised and no appointments were completed between these dates."
        empty-hint="Try a longer span, or check that the practice has demo data seeded."
        fill
      />

      <template v-if="data && !failure && hasAnything">
        <!-- money -->
        <section class="pr-section">
          <h2 class="pr-h">Money</h2>
          <div class="pr-tiles">
            <article class="pr-tile">
              <span class="pr-label">Invoiced</span>
              <strong class="pr-value">{{ money(data.revenue.invoiced) }}</strong>
              <span class="pr-sub">raised in this period</span>
            </article>
            <article class="pr-tile">
              <span class="pr-label">Collected</span>
              <strong class="pr-value">{{ money(data.revenue.collected) }}</strong>
              <!-- Separate from invoiced on purpose: a practice that raised
                   ninety and collected forty has a different problem from
                   one that raised forty and collected forty. -->
              <span class="pr-sub">paid in this period</span>
            </article>
            <article class="pr-tile" :class="{ warn: data.revenue.outstanding > 0 }">
              <span class="pr-label">Outstanding</span>
              <strong class="pr-value">{{ money(data.revenue.outstanding) }}</strong>
              <span class="pr-sub">{{ data.revenue.unpaidCount }} unpaid · {{ money(data.revenue.overdue) }} overdue</span>
            </article>
            <article class="pr-tile">
              <span class="pr-label">Production</span>
              <strong class="pr-value">{{ money(data.production.total) }}</strong>
              <span class="pr-sub">work completed</span>
            </article>
          </div>

          <div v-if="data.production.byDay.length" class="pr-chart">
            <div
              v-for="d in data.production.byDay"
              :key="d.day"
              class="pr-bar-col"
              v-tooltip="`${d.day} · ${money(d.value)} · ${d.items} item${d.items === 1 ? '' : 's'}`"
            >
              <div class="pr-bar-fill" :style="{ height: `${(d.value / productionPeak) * 100}%` }" />
            </div>
          </div>
          <p v-else class="pr-empty">No completed work in this period.</p>
        </section>

        <!-- the diary -->
        <section class="pr-section">
          <h2 class="pr-h">The diary</h2>
          <div class="pr-tiles">
            <article class="pr-tile">
              <span class="pr-label">Chair utilisation</span>
              <strong class="pr-value">{{ pct(data.utilisation.chair.rate) }}</strong>
              <span class="pr-sub">
                {{ hours(data.utilisation.chair.bookedMinutes) }} of
                {{ hours(data.utilisation.chair.capacityMinutes) }} across
                {{ data.utilisation.chair.rooms }} chairs
              </span>
            </article>
            <article class="pr-tile">
              <span class="pr-label">Clinician utilisation</span>
              <strong class="pr-value">{{ pct(data.utilisation.clinician.rate) }}</strong>
              <!-- Two figures, because a practice with one cannot tell which
                   problem it has: chairs full and clinicians idle means hire;
                   the reverse means build. -->
              <span class="pr-sub">
                {{ hours(data.utilisation.clinician.bookedMinutes) }} of
                {{ hours(data.utilisation.clinician.capacityMinutes) }} rostered
              </span>
            </article>
            <article class="pr-tile" :class="{ warn: (data.attendance.noShowRate ?? 0) > 0.05 }">
              <span class="pr-label">Did not attend</span>
              <strong class="pr-value">{{ pct(data.attendance.noShowRate) }}</strong>
              <span class="pr-sub">{{ data.attendance.noShow }} of {{ data.attendance.settled }} that came round</span>
            </article>
            <article class="pr-tile">
              <span class="pr-label">Cancelled</span>
              <strong class="pr-value">{{ pct(data.attendance.cancellationRate) }}</strong>
              <span class="pr-sub">{{ data.attendance.cancelled }} of {{ data.attendance.settled }}</span>
            </article>
          </div>
          <p class="pr-note">
            Both rates are out of appointments whose time has passed — not out of
            everything booked. A denominator that includes next Tuesday flatters
            the number and moves with how far ahead you look.
          </p>
        </section>

        <!-- acceptance -->
        <section class="pr-section">
          <h2 class="pr-h">Case acceptance</h2>
          <div class="pr-tiles">
            <article class="pr-tile">
              <span class="pr-label">By value</span>
              <strong class="pr-value">{{ pct(data.acceptance.byValue) }}</strong>
              <span class="pr-sub">{{ money(data.acceptance.acceptedValue) }} of {{ money(data.acceptance.presentedValue) }}</span>
            </article>
            <article class="pr-tile">
              <span class="pr-label">By count</span>
              <strong class="pr-value">{{ pct(data.acceptance.byCount) }}</strong>
              <span class="pr-sub">{{ data.acceptance.itemsAccepted }} of {{ data.acceptance.itemsPresented }} items</span>
            </article>
            <article v-if="acceptanceGap !== null" class="pr-tile pr-tile-wide" :class="{ warn: acceptanceGap > 0.1 }">
              <span class="pr-label">The gap</span>
              <strong class="pr-value">{{ pct(Math.abs(acceptanceGap)) }}</strong>
              <span class="pr-sub">
                <template v-if="acceptanceGap > 0.05">
                  Patients are accepting the cheaper items and declining the expensive ones.
                </template>
                <template v-else-if="acceptanceGap < -0.05">
                  Fewer items accepted, but the expensive ones are going ahead.
                </template>
                <template v-else>Value and count agree — acceptance is even across the price range.</template>
              </span>
            </article>
          </div>
        </section>

        <!-- recall and growth -->
        <section class="pr-section">
          <h2 class="pr-h">Recall and growth</h2>
          <div class="pr-tiles">
            <article class="pr-tile">
              <span class="pr-label">Recall conversion</span>
              <strong class="pr-value">{{ pct(data.recall.conversion) }}</strong>
              <span class="pr-sub">{{ data.recall.scheduled }} of {{ data.recall.due }} due were booked</span>
            </article>
            <article class="pr-tile pr-tile-wide">
              <span class="pr-label">New patients</span>
              <!-- One bar is not a trend. Below two months this says the
                   number instead of drawing a chart of it. -->
              <template v-if="data.growth.length < 2">
                <strong class="pr-value">{{ data.growth[0]?.joined ?? 0 }}</strong>
                <span class="pr-sub">joined — not enough history yet for a trend</span>
              </template>
              <div v-else class="pr-spark">
                <div v-for="g in data.growth" :key="g.month" class="pr-spark-col" v-tooltip="`${g.month} · ${g.joined}`">
                  <div class="pr-spark-fill" :style="{ height: `${(g.joined / growthPeak) * 100}%` }" />
                  <span class="pr-spark-label">{{ g.month.slice(5) }}</span>
                </div>
              </div>
            </article>
          </div>
        </section>

        <!-- clinicians -->
        <section class="pr-section">
          <h2 class="pr-h">By clinician</h2>
          <table class="pr-table">
            <thead>
              <tr>
                <th>Clinician</th><th>Appointments</th><th>Seen</th>
                <th>Did not attend</th><th>Booked</th><th>Production</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.clinicians" :key="c.id">
                <td>{{ c.name }}</td>
                <td>{{ c.appointments }}</td>
                <td>{{ c.completed }}</td>
                <td>{{ c.noShow }}</td>
                <td>{{ hours(c.bookedMinutes) }}</td>
                <td>{{ money(c.production) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="pr-note">
            Not a league table. Production alone rewards whoever does the
            expensive work, so a hygienist always loses it — the columns sit
            beside each other to be read together.
          </p>
        </section>
      </template>
    </div>
  </private-view>
</template>

<style scoped>
.pr {
  --pr-bg: var(--theme--background, #12181c);
  --pr-soft: var(--theme--background-subdued, #161b22);
  --pr-fg: var(--theme--foreground, #dee4e8);
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
  --pr-dim: color-mix(in srgb, var(--theme--foreground, #4f5464) 80%, var(--theme--background, #f0f4f9));
  --pr-line: var(--theme--border-color-subdued, #21262d);
  --pr-accent: var(--theme--primary, #73b8e8);
  --pr-warn: var(--theme--warning, #ffc23b);
  --pr-radius: var(--theme--border-radius, 5px);

  padding: 0 var(--content-padding, 32px) var(--content-padding, 32px);
  max-width: 1200px;
}

.pr-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; }
.pr-range { margin-left: 8px; color: var(--pr-dim); font-variant-numeric: tabular-nums; }

.pr-section { margin-bottom: 36px; }
.pr-h {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pr-dim);
}

.pr-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.pr-tile {
  display: flex; flex-direction: column; gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--pr-line);
  border-radius: var(--pr-radius);
  background: var(--pr-soft);
}
.pr-tile.warn { border-color: color-mix(in srgb, var(--pr-warn) 55%, transparent); }
.pr-tile-wide { grid-column: span 2; }
@media (max-width: 700px) { .pr-tile-wide { grid-column: span 1; } }

.pr-label { font-size: 12px; color: var(--pr-dim); }
.pr-value { font-size: 26px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
.pr-sub { font-size: 12px; color: var(--pr-dim); line-height: 1.4; }

.pr-note { margin: 10px 0 0; font-size: 12px; color: var(--pr-dim); line-height: 1.5; max-width: 68ch; }
.pr-empty { margin: 12px 0 0; color: var(--pr-dim); font-size: 13px; }

.pr-chart {
  display: flex; align-items: flex-end; gap: 3px;
  height: 110px; margin-top: 14px; padding: 8px;
  border: 1px solid var(--pr-line); border-radius: var(--pr-radius);
}
.pr-bar-col { flex: 1 1 0; height: 100%; display: flex; align-items: flex-end; min-width: 4px; }
.pr-bar-fill {
  width: 100%; min-height: 2px; border-radius: 2px 2px 0 0;
  background: var(--pr-accent);
}

.pr-spark { display: flex; align-items: flex-end; gap: 6px; height: 64px; margin-top: 6px; }
.pr-spark-col { flex: 1 1 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; gap: 3px; }
.pr-spark-fill { min-height: 2px; border-radius: 2px 2px 0 0; background: var(--pr-accent); }
.pr-spark-label { font-size: 10px; color: var(--pr-dim); text-align: center; }

.pr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pr-table th, .pr-table td {
  padding: 8px 12px; text-align: right; border-bottom: 1px solid var(--pr-line);
  font-variant-numeric: tabular-nums;
}
.pr-table th:first-child, .pr-table td:first-child { text-align: left; font-variant-numeric: normal; }
.pr-table th { color: var(--pr-dim); font-weight: 500; font-size: 12px; }

.pr-nav { padding: 12px 16px; }
.pr-hint { margin: 0 0 12px; color: var(--pr-dim); font-size: 13px; line-height: 1.5; }
.pr-hint-quiet { opacity: 0.75; }
</style>
