import { defineModule } from "@directus/extensions-sdk";
import DaySheet from "./day-sheet.vue";

/**
 * Its own module rather than a layout or an interface.
 *
 * A day sheet is a workspace, not a field and not a list of items: it is
 * where the front desk spends the morning. Directus's own layouts cannot
 * express it — the calendar does day, week and month by time, with no
 * resource lane — and a dental diary is read by chair.
 */
export default defineModule({
  id: "day-sheet",
  name: "$t:enamel_module_day_sheet",
  icon: "calendar_view_day",
  routes: [{ path: "", component: DaySheet }],
});
