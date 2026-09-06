# Tooth chart (FDI) — a Directus interface

An FDI dental chart rendered inside the Directus admin. Part of
[Enamel](https://github.com/khanahmad4527/enamel).

- **FDI notation** (ISO 3950): quadrant, then position. Arches are laid
  out as a clinician faces the patient — the patient's right on the
  viewer's left — and molars are drawn wider than incisors.
- **Reads an append-only findings log**, so the chart is a view over
  history rather than 32 mutable rows. Clicking a tooth shows its
  timeline.
- **Missing teeth render as an absence** — no fill, dashed outline,
  strike — because "healthy" and "missing" as two pale off-whites is not
  a distinction a clinical chart can afford to blur.
- **English, German, Dutch and French**, following the operator's Data
  Studio language. Regional variants fall back by language subtag, so
  `de-AT` reads German rather than English.
- **Handles its own 403**: roles without clinical access see an access
  message instead of an empty widget.

## Not published to the Marketplace

This reads `/items/tooth_conditions` and the field names `tooth_fdi`,
`surface`, `condition` and `recorded_at` directly, with `options: null`.
Installed against any other schema it renders an empty chart, so
publishing it would mean exposing the collection and field names as
interface options first. `private: true` in package.json prevents an
accidental publish until then.

## Licence

Business Source License 1.1 — see [LICENSE](./LICENSE). Read it, run it,
learn from it; offering it as a product or hosted service is not
permitted. Converts to MIT on 2030-09-05.
