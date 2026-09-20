import { defineModule } from "@directus/extensions-sdk";
import Queues from "./queues.vue";

/**
 * A page whose only job is to open another one.
 *
 * The board itself is Bull Board, served by the core service on its own
 * origin — it is not embedded here. An iframe would need a cookie marked
 * `SameSite=None; Secure`, which is never sent over plain http, so the
 * local stack and a deployment would behave differently in exactly the
 * area where that is least acceptable. A new tab is a first-party
 * navigation and has none of that.
 */
export default defineModule({
  id: "queues",
  name: "$t:enamel_module_queues",
  icon: "queue",
  routes: [{ path: "", component: Queues }],
});
