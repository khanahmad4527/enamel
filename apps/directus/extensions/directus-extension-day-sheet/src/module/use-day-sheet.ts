import { computed, ref, watch, type Ref } from "vue";
import { minutesOr, shiftIsoDate, weekdayName } from "@enamel/time";
import { messageFrom, type Appointment, type Sheet } from "./types";

/**
 * The floor for pixels-per-minute. See the note on the composable below.
 *
 * Exported for the drag handler, which needs the same number the grid was
 * drawn with — but it reads the live one off the state, not this.
 */
export const MIN_SCALE = 1.4;
/** The gridlines a practice books on. */
export const STEP = 15;
/** Column header height, shared with the CSS through a custom property. */
export const HEAD = 44;

// Method shorthand, not a property holding an arrow. Under `strict`, an
// arrow's parameters are checked contravariantly, so a `config?: unknown`
// here refuses axios — whose config is narrower — and the real instance
// could not be passed to the composable it was written for. Shorthand is
// bivariant, which is what a structural stand-in for a client wants.
type Api = { get(url: string, config?: unknown): Promise<{ data: unknown }> };

/**
 * One day's diary, and everything derived from it.
 *
 * Split out of the component so the grid maths can be read without
 * scrolling past two hundred lines of CSS, and so `load()` has one caller
 * rather than being reachable from three places in a template.
 *
 * The vertical scale is pixels per minute, and it is a floor rather than
 * a constant. 1.4 is the floor because of what a block has to fit: at 1.1
 * a 45-minute appointment was 49 pixels tall and its third line — the
 * clinician and the reason — was cut in half. 1.4 gives it 63.
 *
 * It grows from there to fill whatever height the window leaves. A fixed
 * 1.4 meant a short Saturday — five hours, so 420 pixels — sat in the top
 * third of a tall screen with the rest of the page empty, which reads as
 * a broken layout rather than a quiet day. Now the same five hours use
 * the whole viewport and the blocks are simply bigger, which is what the
 * space is for.
 *
 * Only ever upward. A long day still scrolls at 1.4 rather than being
 * squeezed to fit, because a day sheet that scrolls is normal and one
 * that hides who the patient is seeing is not.
 */
export function useDaySheet(api: Api) {
  const today = new Date().toISOString().slice(0, 10);
  const date = ref(today);
  const sheet = ref<Sheet | null>(null);
  const loading = ref(false);

  /**
   * Two failures, two shapes, because they are not the same event.
   *
   * `loadFailure` is "the day would not load" — the view has no content
   * and cannot get any. That belongs in the stage, as a panel, rendered
   * the same way every other extension renders it.
   *
   * `flash` is feedback on something the user just did: a move that
   * landed, or one the rules refused. That belongs in a toast over the
   * grid, because the grid is still there and still correct, and the
   * message is about the last two seconds rather than about the page.
   *
   * These used to be one `error` ref showing in one toast. That is how
   * "you are signed in as an administrator" ended up as a dismissible
   * notification floating over an empty screen with nothing behind it.
   */
  const loadFailure = ref<unknown>(null);
  const flash = ref<{ text: string; bad: boolean } | null>(null);

  /**
   * Reloads the day without blanking it.
   *
   * `sheet` is deliberately left alone until new data arrives. Clearing it
   * first collapses the grid to nothing and then rebuilds it, which after
   * a drag is a full-height jump under the pointer — and on a refused move
   * it happened *while* the explanation was being shown.
   *
   * `flash` is not cleared here either, for the same reason in a different
   * shape: the drag that just failed wants its explanation to survive the
   * refresh it triggers. Clearing on success only means a stale message
   * cannot outlive a good load.
   */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const res = await api.get("/day-sheet-api/day", { params: { date: date.value } });
      sheet.value = res.data as Sheet;
      loadFailure.value = null;
    } catch (e: unknown) {
      // The failure itself, not a sentence pulled out of it. The status
      // code is what separates "the service is down" from "this view
      // belongs to a practice and your account does not".
      loadFailure.value = e;
      sheet.value = null;
    } finally {
      loading.value = false;
    }
  }

  watch(date, load, { immediate: true });

  const shiftDay = (days: number): void => {
    date.value = shiftIsoDate(date.value, days);
  };
  const goToday = (): void => {
    date.value = today;
  };

  const opensAt = computed(() => minutesOr(sheet.value?.opens_at, 8 * 60));
  const closesAt = computed(() => minutesOr(sheet.value?.closes_at, 19 * 60));

  /**
   * How much vertical room the grid has, measured rather than assumed.
   *
   * Set by the component once it knows where the grid starts on the page,
   * and again whenever the window changes size. Zero until then, which
   * means the first paint uses the floor scale — correct, just not yet
   * stretched.
   */
  const room = ref(0);

  const scale = computed(() => {
    const minutes = closesAt.value - opensAt.value;
    if (minutes <= 0 || room.value <= 0) return MIN_SCALE;
    return Math.max(MIN_SCALE, (room.value - HEAD) / minutes);
  });

  const height = computed(() => (closesAt.value - opensAt.value) * scale.value);
  const weekday = computed(() => weekdayName(sheet.value?.weekday));

  const gridlines = computed(() => {
    const out: Array<{ minute: number; label: string; major: boolean }> = [];
    for (let m = opensAt.value; m <= closesAt.value; m += STEP) {
      out.push({
        minute: m,
        label: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
        major: m % 60 === 0,
      });
    }
    return out;
  });

  const byRoom = computed<Record<string, Appointment[]>>(() => {
    const map: Record<string, Appointment[]> = {};
    for (const room of sheet.value?.rooms ?? []) map[room.id] = [];
    // An appointment with no chair would otherwise vanish. It is a real
    // state — booked before anyone decided where — so it gets its own
    // column rather than being dropped on the floor.
    map["unassigned"] = [];
    for (const appointment of sheet.value?.appointments ?? []) {
      const key = appointment.room && map[appointment.room] ? appointment.room : "unassigned";
      map[key]!.push(appointment);
    }
    return map;
  });

  const unassigned = computed(() => byRoom.value["unassigned"] ?? []);
  const closedRooms = computed(() => (sheet.value?.rooms ?? []).filter((r) => r.closed));

  /**
   * The numbers a practice manager asks for at a glance.
   *
   * "Did not attend" is its own line rather than folded into
   * cancellations: a no-show is lost surgery time somebody has to chase,
   * a cancellation is a slot that came back in time to refill.
   */
  const summary = computed(() => {
    const all = sheet.value?.appointments ?? [];
    return {
      booked: all.filter((a) => a.status === "scheduled" || a.status === "confirmed").length,
      done: all.filter((a) => a.status === "completed").length,
      missed: all.filter((a) => a.status === "no_show").length,
      chairs: new Set(all.filter((a) => a.room).map((a) => a.room)).size,
    };
  });

  /** Where a block sits, and how tall it is drawn. */
  const blockStyle = (a: Appointment) => ({
    top: `${Math.max(0, (a.start_minute - opensAt.value) * scale.value)}px`,
    // A 15-minute appointment is 21 pixels tall and unreadable. Floor the
    // drawn height without changing the stored one.
    height: `${Math.max((a.end_minute - a.start_minute) * scale.value, 26)}px`,
  });

  /** Below this a third line of text would be clipped rather than read. */
  const showsMeta = (a: Appointment): boolean => (a.end_minute - a.start_minute) * scale.value >= 58;

  return {
    today, date, sheet, loading, loadFailure, flash,
    load, shiftDay, goToday,
    opensAt, closesAt, height, weekday, gridlines, scale, room,
    byRoom, unassigned, closedRooms, summary,
    blockStyle, showsMeta,
  } as const;
}

export type DaySheetState = ReturnType<typeof useDaySheet>;
export type { Ref };
