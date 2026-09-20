import { ref } from "vue";
import { clockOf, instantAt } from "@enamel/time";
import { isMovable, messageFrom, type Appointment } from "./types";
import { STEP, type DaySheetState } from "./use-day-sheet";

type Api = { post: (url: string, body: unknown) => Promise<unknown> };

/**
 * Moving an appointment by dragging it.
 *
 * Nothing here decides whether a move is allowed. It works out which chair
 * and which minute the pointer landed on, asks, and shows whatever comes
 * back — the rules are four layers away in Postgres, and the sentence
 * explaining a refusal was written by the scheduling hook.
 */
export function useDayDrag(api: Api, state: DaySheetState) {
  const dragging = ref<Appointment | null>(null);
  const hovering = ref<{ room: string; minute: number } | null>(null);

  function onDragStart(appointment: Appointment, event: DragEvent): void {
    // A completed or cancelled appointment is history. Dragging one would
    // rewrite what happened rather than change what is going to.
    if (!isMovable(appointment)) {
      event.preventDefault();
      return;
    }
    dragging.value = appointment;
    event.dataTransfer?.setData("text/plain", appointment.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function minuteAt(event: DragEvent, column: HTMLElement): number {
    const offset = event.clientY - column.getBoundingClientRect().top;
    // The live scale, not the floor: the grid may have stretched to fill
    // the window, and a drop resolved at the wrong scale lands on the wrong
    // time.
    const minute = state.opensAt.value + offset / state.scale.value;
    // Snap to the booking grid. Dropping at 09:07 is not a thing a
    // practice wants to have happened by accident.
    return Math.round(minute / STEP) * STEP;
  }

  function onDragOver(roomId: string, event: DragEvent): void {
    if (!dragging.value) return;
    event.preventDefault();
    hovering.value = { room: roomId, minute: minuteAt(event, event.currentTarget as HTMLElement) };
  }

  function onDragEnd(): void {
    dragging.value = null;
    hovering.value = null;
  }

  async function onDrop(roomId: string, event: DragEvent): Promise<void> {
    event.preventDefault();
    const appointment = dragging.value;
    const sheet = state.sheet.value;
    onDragEnd();
    if (!appointment || !sheet) return;

    const minute = minuteAt(event, event.currentTarget as HTMLElement);
    if (minute === appointment.start_minute && roomId === appointment.room) return;

    // Built from the clinic's own wall clock, not the browser's. A
    // receptionist in Amsterdam moving a Dubai booking has to move it to
    // eleven o'clock there.
    const length = appointment.end_minute - appointment.start_minute;
    const tz = sheet.practice.timezone;

    state.flash.value = null;
    try {
      await api.post("/day-sheet-api/move", {
        id: appointment.id,
        starts_at: instantAt(tz, sheet.date, minute).toISOString(),
        ends_at: instantAt(tz, sheet.date, minute + length).toISOString(),
        room: roomId === "unassigned" ? undefined : roomId,
      });
      state.flash.value = { text: `Moved ${appointment.patient_name} to ${clockOf(minute)}.`, bad: false };
      await state.load();
    } catch (e: any) {
      // Reload first, then set the message. The other order looks right
      // and silently loses it: the refresh that puts the appointment back
      // where it started would also wipe the explanation of why it went
      // back.
      const refusal = messageFrom(e, "That move was refused.");
      await state.load();
      state.flash.value = { text: refusal, bad: true };
    }
  }

  return { dragging, hovering, onDragStart, onDragOver, onDrop, onDragEnd, clockOf } as const;
}
