import { defineInterface } from "@directus/extensions-sdk";
import RadiographViewer from "./radiograph-viewer.vue";

export default defineInterface({
  id: "radiograph-viewer",
  name: "$t:enamel_iface_radiograph",
  icon: "imagesearch_roller",
  description: "$t:enamel_iface_radiograph_desc",
  component: RadiographViewer,
  // The stored value is a file uuid, exactly like the built-in `file`
  // interface. This replaces how it is *displayed*, not what it is, so a
  // practice can switch back to the stock interface and lose nothing.
  types: ["uuid"],
  localTypes: ["file"],
  relational: true,
  group: "relational",
  options: [
    {
      field: "invertByDefault",
      name: "$t:enamel_iface_radiograph_invert",
      type: "boolean",
      meta: {
        interface: "boolean",
        width: "half",
        note: "$t:enamel_iface_radiograph_invert_note",
      },
      schema: { default_value: false },
    },
  ],
});
