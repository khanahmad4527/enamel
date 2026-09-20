import { defineModule } from "@directus/extensions-sdk";
import PracticeReport from "./report.vue";

/**
 * Its own module rather than an Insights dashboard.
 *
 * Directus Insights handles half of this and is used for that half — a
 * dashboard of panels ships alongside. What a panel cannot do is divide
 * one aggregate by another, and every rate here is a ratio.
 */
export default defineModule({
  id: "practice-report",
  name: "$t:enamel_module_report",
  icon: "insights",
  routes: [{ path: "", component: PracticeReport }],
});
