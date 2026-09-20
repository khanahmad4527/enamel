import { defineInterface } from "@directus/extensions-sdk";
import InterfaceComponent from "./interface.vue";

export default defineInterface({
  id: "tooth-chart",
  name: "Tooth chart (FDI)",
  icon: "dentistry",
  description:
    "Renders an FDI dental chart from the tooth_conditions log. Attach to an alias field on patients.",
  component: InterfaceComponent,
  // An alias field holds no column of its own — it's a presentation slot.
  types: ["alias"],
  localTypes: ["presentation"],
  group: "presentation",
  options: null,
});
