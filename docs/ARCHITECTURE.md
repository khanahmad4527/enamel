# Enamel — how it is built

This is the engineering half of the documentation. [The README](../README.md)
explains what Enamel is and what each part does, without assuming you write
software; this explains how, and why each decision went the way it did.

It is long on purpose. Most of it is the reasoning behind a choice rather
than a description of the code, because the code can be read and the
reasoning cannot.

---

## The tooth chart

<p align="center">
  <img src="docs/screenshots/tooth-chart.png" alt="FDI dental chart rendered inside the Directus admin" width="900">
</p>

A custom Directus interface, in [`apps/directus/extensions/directus-extension-tooth-chart`](../apps/directus/extensions/directus-extension-tooth-chart).
It uses **FDI notation** (ISO 3950 — quadrant, then position), lays the arches
out as a clinician sees them (patient's right on the viewer's left), and sizes
molars wider than incisors so the chart reads anatomically.

Missing teeth are drawn as an *absence* — no fill, a dashed outline and a
strike — rather than a pale tooth, because "healthy" and "missing" rendered as
two similar off-whites is exactly the kind of ambiguity a clinical chart cannot
afford. Selecting a tooth lifts it and underlines it in the accent colour, which
reads as a chart annotation rather than a stray browser outline.

It renders from `tooth_conditions`, which is an **append-only log** rather than
32 mutable rows per patient. "What is tooth 26 today" is simply its latest
entry, and the clinical history stays intact. Click any tooth for its timeline.

Front-desk policies do not grant the `tooth_chart` field, so the desk never
sees the chart at all — not a locked door, no door. The interface keeps a 403
branch anyway, because a policy that grants the field and denies the log is one
edit away, and an interface that renders "Unexpected Error" in that case would
be reporting a permission decision as a bug.

It is **not published to the Marketplace**, and `private: true` in its
package.json prevents an accidental `npm publish`. The reason is honest:
it reads `/items/tooth_conditions` and the field names `tooth`, `surface`,
`condition`, `recorded_at` and `notes` directly, with `options: null`.
Installed anywhere but here it would render an empty chart. Publishing it
would mean exposing those as interface options first — worth doing, but a
separate piece of work, not a `npm publish` away.

## Payment plans, the cancellation list, and lab work

Three named, shipped features that demos leave out — and the interesting
part is where the real products *disagree with each other*, because that
disagreement is in the schema rather than averaged away.

### A payment plan is not a repeating charge

A principal, a schedule, an APR, and a down payment that is **subtracted
before the schedule and the interest are computed** — it is not the first
instalment. Three plan types, not the four you find in Open Dental,
because two of those ("Patient Payment Plan" and "Old Payment Plan") are
the same object under a rename.

Two pairs of fields are mutually exclusive and nothing in a single-field
validation can say so: interest-free-payment count **or** interest start
date; number of payments **or** payment amount. Directus validation
constrains a value, not a pair, so the rule is stated in the field notes
and **asserted by the suite** instead of being quietly hoped for.

The schedule is computed by whoever writes the plan, because a flow cannot
do arithmetic. Which surfaced a real bug worth keeping: twelve payments
rounded to the cent left **five cents outstanding**. The final instalment
now absorbs the drift, and a check asserts every schedule repays its
principal exactly and lands on a zero balance — €1,630 financed at 6.9%
over twelve months, €61.57 of interest, closing at €0.00.

`permanent_lock` is a field rather than a consequence, because whether an
APR forces a lock depends on a practice-level preference — and the label
changed from "Full Lock" in v24.3, which is the sort of thing that makes a
copied screenshot wrong.

### The waiting list, and what is *not* universal

This is the one where averaging the products would have invented a model
nobody ships. Open Dental's ASAP List is a **binary flag** — patients "who
would like to be contacted when an earlier appointment becomes available"
— with no urgency field and no stored declined state. Its only ordering is
a fixed system heuristic, and a patient declining is an opt-out that
suppresses notifications rather than a state on the list. Denticon's Quick
Fill documents neither.

Priority tiers and wait-time targets are **Dentally only**, and even its
"declined" is documented as a note rather than a structured value. So they
are here as optional fields under a divider that says *"Optional — not
universal"*, with the provenance in the note. A check asserts the list
still works with the priority empty, because that is the shape most
products actually have.

What all of them agree on is `source` — how the patient reached the list —
so that is required, and it is what Open Dental orders its outreach by.

### Lab cases: four timestamps, not a status

Another genuine fork. Dentally models lab work as a single enum on the
appointment (None required / Sent / Received / Overdue, shown as a
coloured beaker). Open Dental models it as a timestamp state machine. The
enum is simpler; the timestamps answer *how long was it at the lab* and
*was the fit checked before the patient sat down*, which the enum cannot.

So: `due_at`, `sent_at`, `received_at`, `checked_at` — and the gaps
between them are the point. **`sent_at` is when the case was packaged and
put out**, which "may not actually be picked up until hours later", and
**`checked_at` is quality checked, a different act from received**. A check
asserts the seeded data contains all three states: out at the lab, back
but not yet checked, and checked.

Instructions stay free text. A shade is written the way the technician
reads it — `PFM crown 46. Shade A1.` — and every attempt to enumerate
shade systems ends in a dropdown that does not contain the one this lab
uses.

Two nullable appointment links, not one: the booked visit and a planned
one. The manual says a case "should always be attached to an appointment"
and that unattached cases show as unattached — a workflow expectation, not
a constraint, so the schema does not pretend otherwise.

## Periodontal screening and charting

Two different acts, so two different shapes. A BPE is a **screen** — six
numbers, thirty seconds — and the BSP is explicit that it "should be used
for screening only and should not be used for diagnosis" and "cannot be
used to monitor the response to periodontal therapy". A full chart is six
measurements per tooth and is what you monitor with. Fold them together
and you get a screen pretending to be a chart.

### The BPE, and why the version is a column

| | |
|---|---|
| **Codes 0–4** | Stored as the clinician recorded them, never recomputed from millimetres |
| **The asterisk is a second axis** | BSP: "Both the number and the * should be recorded if a furcation is detected. E.g. the score for a sextant could be 3*" — so it is a boolean beside the code, never a fifth value |
| **Six sextants** | UR 17–14, UA 13–23, UL 24–27, LR 47–44, LA 43–33, LL 34–37, in FDI |
| **Empty ≠ zero** | A sextant needs at least two teeth to score. Null means not scored, with a reason, because the BSP defines no symbol for it — its own worked example just shows a dash |

`guideline_version` is not bureaucracy. **The asterisk meant total
attachment loss before 2011 and furcation involvement from 2011.** The
third-molar rule changed in 2016 (now excluded *unless* the first or second
molar is missing), and the pre-2016 rule that carried a single remaining
tooth into the adjoining sextant was dropped. A code from 2009 and a code
from today are not the same measurement, and without the version you
cannot tell them apart.

The code is never derived from a probing depth, and the reason is
uncomfortable: **the BSP's own wording disagrees with itself at exactly
3.5mm.** The 2011 text says "no pockets >3.5mm" for codes 0–2 while 2019
says "pockets <3.5mm", and 3.5 falls in the gap. A system that computed
the code would be inventing a boundary the guideline declines to draw.

### The chart, and the one place a sign error is dangerous

Six sites per tooth — **MB, B, DB, ML, L, DL**. In the maxilla the lingual
three are the palatal three; that is a label, not a column.

The gingival margin is the single field where an inverted sign produces
clinically wrong output *in silence*, and both conventions genuinely exist
in shipping software. So the field is called **`recession_mm`** rather than
`gingival_margin`, which is the ambiguous name, and the convention is
stated once and enforced by that name:

```
recession_mm > 0   margin apical to the CEJ — root exposed
recession_mm = 0   margin at the CEJ
recession_mm < 0   margin coronal — overgrowth, pseudopocket

CAL = probing_depth_mm + recession_mm
```

This matches Eaglesoft ("a positive value between 1-19 when the gum line
is below the CEJ", "a negative value of 1-10 when the gumline is above"),
Dentrix and Open Dental, so an import needs no sign flip. A check asserts
that a receded site reads *deeper* than it probes — which is what fails
first if anyone flips it.

**CAL is not stored.** It is derived from two columns in the same row, and
a stored copy is a column that can disagree with its own inputs. Open
Dental calls its own "auto CAL" and computes it; here any query can.

Three more distinctions that cost nothing to model and everything to
retrofit:

- **Null is not zero.** A 0mm probing depth is a real if unusual reading;
  a site that was not probed is a different fact. Open Dental uses `-1` as
  a sentinel for the same reason — a nullable column says it better.
- **Mobility is per tooth, never per site.** A tooth moves as a rigid
  body. A check asserts the site table has no mobility column at all. The
  four-point scale is stable but its *attribution* is not — the "Miller
  index" is reported inconsistently and products disagree — so which index
  a grade belongs to is recorded beside it rather than assumed.
- **Furcation only exists on multi-rooted teeth, and the entrances differ
  by tooth.** Mandibular molars have two, buccal and lingual. Maxillary
  molars have three, opening mesiopalatally and distopalatally. Upper first
  premolars have two, mesial and distal — which is why they get missed.
- **`assessed_*` looks like clutter and is not.** A bleeding score of 12%
  means nothing unless you know how many sites were probed for bleeding. A
  chart with recession unassessed is a different chart from one where every
  recession happened to be zero.

The seed makes the clinical story rather than filling a grid: a BPE with
`4*` in the lower left, and the partial chart that finding obliges —
because a real chart is not always 192 rows, and assuming it is was the
mistake worth avoiding.

## Scheduling: four layers, and why

Appointments were a table with a start and an end, and nothing stopped two
patients being booked with the same dentist at the same minute. Adding the
rule found four such pairs already in the demo data — identical start,
identical end, two different patients — created by nothing more exotic
than running the seed twice on different days.

The rule is four layers deep on purpose, and each one exists because the
one above it cannot do the job.

### Postgres, because it is the only layer nothing routes around

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_no_practitioner_overlap
  EXCLUDE USING gist (
    practitioner WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('scheduled', 'confirmed'));
```

Same again for `room`. Two details carry most of the weight. The ranges are
half-open — `[)` — so an appointment ending at 10:00 does not collide with
one starting at 10:00, which is the difference between a full diary and one
that refuses every back-to-back booking a practice actually runs. And the
`WHERE` clause means a cancelled or completed appointment stops holding the
slot, which is what lets reception free a chair by cancelling rather than
deleting.

Directus validation cannot express this. It sees one row; an overlap is a
statement about two. A service could check it and race itself. Postgres
serialises the check with the insert, so `pnpm verify` asserts the strong
form by going around Directus entirely and writing raw SQL:

```
PASS  Postgres refuses a double-booking that never touched Directus   SQLSTATE 23P01
```

That is the difference between "no client can double-book" as a claim about
the database and as a claim about the code paths somebody remembered to
guard.

### A trigger, because the answer lives in four tables

A constraint sees one row and no other table. Whether an appointment is
*possible* — the practice open, the clinician on shift, nobody on leave,
the chair in service — is a question for `clinic_hours`,
`practitioner_hours`, `absences` and `room_closures`. So that is a trigger,
which is the same bargain: inside the transaction, for every writer, with
no way past it.

One judgement runs through it, and it is a judgement rather than a fact:

- **A pattern constrains only once somebody has defined it.** A practice
  with no opening hours on file is not shut — it has a rota nobody has
  filled in, and refusing every booking until they do makes the feature
  impossible to adopt.
- **A block always blocks.** Leave and chair closures are positive
  statements somebody made on purpose. There is no reading of an empty
  `absences` table that should let a booking through a recorded one.

### A hook, because `ENAMEL_CLOSED` is not an error anybody can act on

A constraint violation reaches an API caller as **HTTP 500 with the raw
insert statement in the message** — which leaks the schema to any
authenticated caller and tells a receptionist nothing. The scheduling hook
asks the same questions first and answers in words:

```
Hannah Prins is already booked from Mon 14 Sept, 09:00 to 09:45 — pick another time, chair or clinician
The practice is open 08:00–19:00 on a Tue
They do not work on a Tue
That chair is out of service then
```

The hook races and the constraint does not. Losing the race costs you the
ugly 500 instead of a double-booked chair, which is the right way round.

The times in those messages are in the *practice's* timezone, which took
two goes. Kadehuis is in Amsterdam and Marina in Dubai; the first version
rendered in the container's zone and told a receptionist standing in
Amsterdam that her eight o'clock clash was at six.

### `core`, for the two things none of the above can do

This is the part that makes Enamel stop being a single-service project, so
it is worth being plain about the trade. A second service is a second
deploy, a second thing to explain, and it dilutes "a dental backend on
Directus, no custom backend". It earns its place on two counts:

**Slot search.** "Find the next 45 minutes with Dr Okafor" is the
intersection of five tables across a date range. Through the items API that
is dozens of round trips and a pile of client-side date arithmetic; in SQL
it is four queries and a walk. The service reads Postgres directly for
this — and *only* for this.

**Reminders that can be seen to have failed.** The Directus flow this
replaces calls the mail operation, which invokes `send()` without awaiting
it and swallows the rejection. A bounced address, a refused connection and
a delivered message were indistinguishable, and the flow marked the
appointment reminded either way. BullMQ retries with backoff, keeps
failures on the failed set, and `/api/reminders/status` will tell you the
number.

It is called `core` rather than `scheduler` because the next thing to land
in it is not scheduling: rendering an invoice PDF, which no Directus flow
can do. Naming a process for its first feature is how you end up with a
`scheduler` that sends invoices.

The credential is named the other way round. The reminder sweep's account
is called **Reminder worker**, not "core service", because it is scoped to
a job rather than to a process — read the diary, set one boolean. When
`core` grows a second background job it gets its own account at its own
width; "the service's token" is how one credential quietly acquires
everything the service can do, which is everything.

Two rules keep the service from becoming a hole in the permission model,
because its database connection has no policy layer underneath it:

- **Reads are scoped by a clinic taken from the caller's token, never from
  the request.** `?clinic=<somebody else's id>` changes nothing, and the
  suite asserts that. An account with no clinic — the admin — is refused
  rather than shown everything.
- **Every write goes back through Directus with the caller's own token**,
  so policies, the scheduling hook and the audit trail all apply exactly as
  they would to a booking made in the admin.

The background sweep is the one thing with no user to borrow a token from,
so it carries a static one. Its policy grants read on the diary and **update
on exactly one boolean** — a leaked reminder token cannot move an
appointment, read a medical alert or see an address.

## The numbers, and which half Directus already does

Directus Insights is good at one shape: one aggregate, over one collection,
with one filter. Revenue invoiced this month, outstanding balance, overdue
count, new patients, production over time — all of those are panels, and a
dashboard of seven ships with the schema. Rebuilding them in a custom
module would be writing a worse copy of a shipped feature.

The scoping there is free, and worth noticing. A panel queries through the
items API as whoever is looking at it, so the same policy filter that stops
a Kadehuis receptionist reading Marina's invoices also stops her
aggregating them:

```
owner@kadehuis   outstanding  28,477
owner@marina      outstanding  30,117
admin (no clinic) outstanding  58,594
```

What a panel cannot do is divide one aggregate by another, and every figure
a practice owner actually manages by is a ratio. Those are a module, backed
by the core service:

| | |
|---|---|
| Chair utilisation | booked chair-minutes ÷ open hours × chairs, **less closures** |
| Clinician utilisation | booked minutes ÷ rostered sessions, **less leave** |
| Did not attend | no-shows ÷ appointments **whose time has passed** |
| Cancellation rate | cancellations ÷ the same denominator |
| Case acceptance | accepted ÷ presented, **by value and by count** |
| Recall conversion | recalls booked ÷ recalls that came due |

Each of those denominators is a decision, not a detail, and the decisions
are written next to the queries that implement them.

Two are worth pulling out.

**The denominator of a no-show rate.** Out of *all* appointments in a
range, next Tuesday's booking counts as a success — which flatters the
number and makes it move with how far ahead you look. Out of appointments
whose time has passed, it means what a practice thinks it means.

**Acceptance is reported twice on purpose.** A practice accepting 36% of
plan value but 50% of items is one where patients say yes to the fillings
and no to the crowns. Either number alone tells the wrong story half the
time, so the gap between them gets its own tile rather than leaving
somebody to subtract two percentages in their head.

Utilisation is two figures for the same reason: chairs at 90% with
clinicians at 50% means hire someone; the reverse means build a surgery.
One number cannot tell you which.

### A bug this found

The invoice totals used to be kept by two Directus flows. A flow keys its
update on `{{$trigger.payload.invoice}}` — a single value when one line is
created and an **array** when fifty are. Batch-creating lines wrote each
invoice's total onto a *different* invoice:

```
MAR-…-001  subtotal 600   total 1040.60   should be  726.00
MAR-…-004  subtotal 1025  total  726.00   should be 1240.25
```

Not an error — plausible wrong numbers across the ledger. The suite's "no
total is its subtotal plus tax" check is what caught it.

It cannot be fixed in a flow: doing it properly needs a loop over the
batch, flows have no loop without `exec`, and `exec` does not run in the
`directus/directus:11` image at all. So it moved to a row-level database
trigger, which fires once per row whether you inserted one or five hundred.

That also closed a gap the flows could never cover, and which the README
used to document as a limitation: on delete Directus hands a flow the
deleted keys but not the row, so there was no way to learn which invoice a
removed line belonged to and the subtotal simply went stale. `OLD` knows.

## Who looked at what

Directus keeps a decent activity log — creates, updates, deletes,
successful logins, flow runs, each with an IP, a user agent and an origin.
Permission changes are in there too, because editing a policy is a write to
`directus_permissions` like any other. None of that is reinvented here, and
`pnpm verify` asserts it rather than duplicating it.

Two things are missing, and I checked rather than assumed:

```
SELECT action, count(*) FROM directus_activity GROUP BY action;
 create 3649 · update 886 · delete 362 · login 27 · run 24
                                      -- read: 0 rows, ever
```

**Reads are not logged at all.** That is a deliberate platform decision and
the right default — for most applications the volume would be absurd. A
dental practice is not most applications: *which of my staff opened this
patient's record, and when* is the question an information-governance
review actually asks, and nothing in the platform could answer it.

**Failed sign-ins are not logged either.** A successful login appears. Four
wrong passwords against a dentist's account at two in the morning leave no
trace whatsoever.

So `access_log` is a separate table, for three reasons that are each about
it being a different kind of record from activity:

- **Volume.** Reads outnumber writes by orders of magnitude. Mixing them in
  would ruin the activity view for the thing it is already good at.
- **Immutability.** `directus_activity` can be edited by an administrator.
  An audit log the most powerful account can rewrite is not evidence of
  anything.
- **Shape.** It carries a `patient`, so "who has opened Mrs Okafor's file
  this year" is one query rather than a different join per collection —
  which is the difference between a log that gets read and one that does not.

### The database is what makes it append-only

```
UPDATE access_log SET ip = '0.0.0.0' WHERE …;
ERROR:  ENAMEL_LOG_IMMUTABLE
HINT:  An access-log row cannot be changed once written.
```

That is a superuser `psql` session, not the admin UI. Directus permissions
stop the interface; the trigger stops everything.

Deletion is the more interesting half. Blocking it outright sounds stronger
and is unworkable — a log nobody can prune grows until it is somebody's
outage, and an audit trail that takes the practice offline gets deleted by
someone in a hurry with the trigger disabled. So deletion is allowed, but
only past a 400-day retention window. Pruning last year's rows works;
quietly removing this morning's does not, and the suite asserts both.

The retention period is a constant in the function body rather than a
setting, because a retention period that can be changed at run time by
whoever wants to delete something is not a retention period.

### What it deliberately does not do

- **It does not log every read.** Only collections carrying
  patient-identifiable data. Logging every look at the price list would
  bury the row that matters.
- **It does not log internal reads.** Directus services called with
  `accountability: null` are this codebase talking to itself — the
  scheduling hook checking for a clash. Recording those as "unknown user
  read patients" makes the log less trustworthy, not more.
- **It does not fail the request when the log write fails.**
  `items.read` is an action hook and fires after the read has happened, so
  there is nothing left to refuse. A system under a regulator would use a
  filter hook and fail closed. This is a deliberate trade, not an
  oversight, and the failure is logged at error level so it cannot pass
  silently.
- **Nobody can write a row by hand**, including the practice owner. The
  hook authors them with `accountability: null` precisely so that no role
  needs create permission — a row anybody can author is a row anybody can
  forge.

One hole was worth closing rather than documenting away: the core service
reads Postgres directly, so its day sheet — a dozen patients by name —
never touched Directus and left no trace. It now writes its own rows, to
the same table, through the same trigger. The slot search does not, because
it returns free times and no identities.

## Documents and imaging

A practice's images are the part of the record most likely to leak and the
part most likely to be wrong about whose they are. Both of those are
addressed here; rendering them beautifully is not the interesting problem.

### The boundary is on the file, not on the row

This module got it wrong at first, in a way worth keeping written down:
hiding the *document row* from reception hid the metadata and not the
bytes. `/assets/<uuid>` answers on `directus_files` alone, so a
receptionist who could not see a radiograph in the list could still open
it by URL. The verify suite caught it; nothing else would have.

The marker is a plain boolean-ish column on the file — `document_kind` —
rather than a relational filter through the document that references it.
That matters because a relational filter inside a permission is evaluated
with the caller's own visibility, so "no radiograph document points at
this file" was *true for reception about every file in the building*. The
filter was correct, its evaluation was circular, and the result was a
permission that granted everything it meant to deny.

### Two rules that were written and did not work

Both were found while building this, both had the same cause, and it is a
Directus behaviour worth knowing.

`crud()` in the policy file takes an `extra` filter that narrows a
collection — "only the document kinds reception handles", "only your own
treatment records". It put that filter in `permissions`. **Directus
ignores `permissions` on a create**: there is no existing row to filter,
and the payload is checked against `validation` instead.

So:

- a receptionist could file a **radiograph**, and
- a hygienist could record treatment under the **principal dentist's
  name**.

The second is not a permissions nicety. A treatment record is the legal
account of what was done and by whom, and one filed under somebody else's
name is a falsified clinical record.

Both bugs had the property that lets this kind survive: the row is created
and then **invisible to whoever created it**, because the read permission
does filter correctly. The list looks right immediately afterwards. Only
asking "did that POST actually succeed" finds them, which is what the
suite now does.

### A retake never overwrites what it replaces

Retakes happen — a bitewing with the film clipped, a consent form
re-signed after the plan changed, a referral letter corrected. The wrong
way to handle that is to swap the file on the existing row, which is a
silent edit to a clinical record.

So a retake is a *new* row pointing back at the one it replaces, and the
chain is guarded in Postgres:

| | |
|---|---|
| A document superseding itself | refused — reads as a cycle to anything walking the chain |
| Superseding one on **another patient's file** | refused — this is the one that matters; an m2o picker is not a control, and anything with a token can send any uuid |
| Two documents superseding the same one | refused — the chain forks and "which is current" stops having an answer |
| Superseding with no reason given | refused — "a newer one exists" records nothing, and a retake for positioning and a retake of the wrong tooth are different facts |
| Deleting the document a retake replaced | refused by the foreign key, and explained as *"a later version replaced it, so it stays on file — set its status to archived instead"* |

The back-pointer is maintained by the trigger, not by the caller: a column
two clients both have to remember to set is a column that is wrong by the
second week.

Each of those is answered twice — by a hook, so the answer is a sentence,
and by the database, so the answer is the same for anything holding a
connection. The hook races and the trigger cannot, which is the right way
round.

### A viewer that adjusts without altering

Directus shows an uploaded image as a thumbnail with a lightbox. That is
right for a logo and wrong for a bitewing: the first thing anybody does
with a radiograph is make it bigger, then brighter, then darker, then
inverted, because a shade of grey that hides an interproximal lesion at
one exposure shows it at another. A viewer without those controls is a
viewer nobody uses, and the work goes back to exporting the file and
opening it elsewhere — which is how images escape the records system.

So `radiograph-viewer` replaces the stock `file` interface on
`documents.file`: zoom, pan, brightness, contrast, invert, reset. The
stored value is still a file uuid, so a practice that would rather have
the built-in interface changes one line and loses nothing.

Two things it deliberately is not:

- **Not destructive.** Every adjustment is a CSS filter on the way to the
  screen. The file is never re-encoded and nothing in the component can
  write to it. An "enhance and save" button on a clinical image is a
  records-integrity problem wearing a feature's clothes, because the
  version the practice later relies on is then not the version the sensor
  produced. When anything is adjusted the image is captioned *"Adjusted
  for viewing — the stored image is unchanged"*.
- **Not diagnostic-grade.** A diagnostic display is a calibrated monitor
  at a known luminance, and no amount of web code makes a laptop one. The
  footer says so, because a viewer that quietly implies otherwise is worse
  than one that admits it.

### DICOM, honestly

DICOM is two different problems wearing one file extension, and the
honest answer is different for each.

**The header is read.** It is a tag-length-value stream with a documented
dictionary, and `apps/core/src/imaging/dicom.ts` parses it — modality,
study date, manufacturer and model, dimensions, bit depth, window and
level, and the patient name and date of birth the study carries about
itself. `GET /api/imaging/dicom/:document` returns that, fetching the
file with the **caller's own token** and only the first 512 KB of it: a
CBCT volume is hundreds of megabytes, and pulling a whole study to read a
date would be a denial of service anybody with a token could aim at the
practice.

That is worth doing for one reason above the others. A sensor exports by
study number, and the commonest imaging incident in a practice is a study
attached to the wrong patient's file. The study itself knows, so the
endpoint compares the name in the header against the name on the record
and says when they disagree. The seed ships two studies precisely so this
is demonstrable — one that matches and one that does not, because a demo
where every study matches demonstrates nothing.

One correctness note, because the obvious implementation gets it wrong:
compression applies to the **pixel data**, not to the dataset. A JPEG 2000
study still writes every other tag as plain explicit VR little endian. A
parser that bails out on "not the plain transfer syntax" therefore loses
the patient name on exactly the files a modern sensor produces — which is
to say, it disables the wrong-patient check on the studies that most need
it. Only implicit VR (which needs the full tag dictionary) and big endian
(which needs every read byte-swapped) actually stop the parse, and when
they do the reading says so rather than returning an empty header.

**The pixels are not drawn**, and that is a decision rather than a gap.
Rendering DICOM properly means:

- **Transfer syntaxes.** Pixel data can be raw, RLE, JPEG baseline,
  lossless JPEG, JPEG-LS or JPEG 2000. The last three are what dental
  sensors and CBCT units actually emit, and no browser decodes any of
  them. You ship codecs — usually compiled to WebAssembly — and then you
  maintain them.
- **Windowing.** A 12- or 16-bit sample does not become an 8-bit screen
  value by guessing. It needs the study's modality LUT and VOI LUT.
- **Volumes.** CBCT is a stack, and a viewer that shows slice one of four
  hundred is not a CBCT viewer.
- **A calibrated display**, which is not a software problem at all.

That is a product — it is what OsiriX, Horos and every PACS vendor sell —
and a bad one inside a practice management system is worse than none,
because a bad one still looks like it works. So the viewer says what the
file is and what it would take, the file is kept intact for a workstation
that reads it, and the route out is DICOMweb: WADO-RS to fetch, STOW-RS
to store, QIDO-RS to search. That is an adapter boundary, and drawing it
in the right place is the part that would survive.

### What a patient can reach

Consent forms and correspondence, and only those — the permission walks
from the file back through the document to the patient, so they reach the
bytes of their own consent form and of nothing else. Radiographs and
clinical photographs are deliberately absent from the portal. They are
read with a dentist, not alone on a phone, and the patient site says so
rather than silently showing a shorter list.

## Talking to patients

Reminders started as a Directus flow, and the flow was the problem. It
could not fail visibly: a send that did not happen left no row, no retry
and nothing to look at, so "have the reminders gone out" was a question
nobody in the building could answer. It also only knew one channel, and
only one direction.

What replaced it is a log, three adapters and a queue.

### The log is the authority, not a flag

`messages` records every message in either direction: channel, kind,
subject, body, provider id, failure reason, and which appointment or
patient it was about. Nothing asks "has the reminder been sent?" by
reading a boolean on the appointment. The sweeps ask the log:

```sql
NOT EXISTS (SELECT 1 FROM messages
             WHERE appointment = a.id AND kind = 'confirmation')
```

A boolean per kind means a new kind of message needs a new column and a
migration; and a boolean that is set before the send is a lie the moment
the send fails. Asking the log costs an index and answers every kind,
including the ones that do not exist yet.

The row is written **`queued`, before anything is queued**. A row written
after a successful send is a row that does not exist when the send
crashes — which is precisely the case worth being able to see.

### Three channels, one interface, and a real provider behind each

`ChannelAdapter` has one method. Email is real SMTP to Mailpit, so the
whole path is something you can watch rather than take on trust. SMS and
WhatsApp default to mocks that record what they would have sent and hand
back an id visibly prefixed `mock:` — no account with anybody, and no
pretending.

`send()` returns `{ok: false, reason, retryable}` rather than throwing.
The difference matters to the queue: "the provider is down" should be
retried and "that number is not a mobile" should not, and an exception
flattens the two into one.

#### Turning on a real provider

Environment variables, no code:

```bash
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+31201234567       # or TWILIO_MESSAGING_SERVICE_SID=MG...
```

```bash
WHATSAPP_PROVIDER=meta
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_TOKEN=...
WHATSAPP_TEMPLATE=appointment_reminder_v1
```

```bash
PAYMENTS_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
```

**Half of that is a boot failure, not a warning.** Set `SMS_PROVIDER=twilio`
and forget the auth token and the container refuses to start, naming every
variable it is missing. The tempting behaviour — warn, fall back to the
mock, carry on — means a practice believes it is texting patients about
their appointments and is not, while every `messages` row says `sent`,
because to a mock they were. That is worse than having no SMS at all.

A misspelt name is refused for the same reason. `SMS_PROVIDER=twillio` is
a typo, not a request for the mock.

Then `GET /api/integrations/preflight`, as an administrator, asks each
provider the cheapest authenticated question it has — Twilio's
`GET /Accounts/{Sid}`, Meta's `GET /{phone-number-id}`, Stripe's
`GET /v1/balance` — and reports what came back, including whether Stripe
is in live mode. That is the half of "swap a provider with a variable"
that usually gets discovered by sending a real reminder to a real patient.

#### How they are tested without an account

There is no Twilio account here, no Meta business and no Stripe key, and
there is not going to be. That is normally where an integration stops
being testable and becomes a comment saying *the real implementation is
about fifteen lines*.

It does not have to be. Every adapter takes its base URL from the
environment — which a real deployment needs anyway, for Twilio's regional
endpoints, Meta's pinned Graph version and `stripe-mock`. So the actual
adapter classes are pointed at a server that answers the way each
provider's reference says it will, and the things worth asserting are:

- the method, path, auth scheme and content type;
- the exact parameter names — `MessagingServiceSid` **replacing** `From`
  rather than joining it, `amount` in integer minor units with a lowercase
  currency, the caller's key on `Idempotency-Key`;
- and the judgement the queue depends on — a Twilio 21610 (the recipient
  replied STOP) is never retried, a 429 always is; a Stripe decline is
  final, a 500 is worth another go *because* the idempotency key makes it
  safe; a WhatsApp 132001 means the template was never approved and no
  amount of waiting will approve it.

`pnpm --filter @enamel/core test:adapters` — 35 assertions, and the verify
suite runs it. What it cannot prove is that the provider agrees: a stub
answers how the documentation says it will, and only a live account shows
that it does. That boundary is written down rather than implied.

### Consent is resolved above the adapters

`allow_email`, `allow_sms` and `allow_whatsapp` live on the patient, with
email on by default and the other two off — a practice has an address
because it was given for correspondence, and holding a mobile number is
not consent to text it.

A declined channel is not skipped silently. It is recorded as `suppressed`
with the reason, because "we did not text them" and "we never tried" look
identical in an empty table, and only one of them is a working consent
system.

Checked at **send** time, not audited afterwards. A patient who opted out
last week leaves yesterday's email looking like a violation when it was
not, so a check against historical rows cannot answer the question — the
suite sends one and watches it be refused.

### Two directions

Patients reply. A provider webhook on **its own secret**, deliberately not
the operator token: handing a messaging provider a credential that can
also read the queue is one leak where there should be none. An inbound
message that matches no patient still gets a `200` with `matched: false` —
the provider did its job, and a 4xx would make it retry a message that was
recorded perfectly well.

## The day sheet

Directus ships a calendar layout. It does day, week and month by time, and
it has no notion of a resource lane — so it cannot draw the one view a
practice actually works from, which is chairs across the top and time down
the side. That is a custom module, and the second reason this project has
extensions at all.

Drag an appointment onto one that is already there and the refusal comes
back as the hook's sentence. Getting it there took fixing two bugs worth
recording, because both are the kind that leave a feature looking finished:

- The error was set, then the refresh that put the appointment back cleared
  it — `load()` resets `error` on the way in. The banner flashed and
  vanished, so a refused move looked like nothing happening.
- The message then arrived as "Request failed with status code 400". Nest
  renders a rejection as `{ statusCode, message }` and the admin reads
  Directus's `{ errors: [{ message }] }`; the sentence survived four hops
  and died on the fifth, in a shape mismatch.

## The patient site

`apps/public` is the other half of the product: a small React Router v7
site, server-rendered in workerd — the runtime Cloudflare Workers run, so
`pnpm dev`, the container in this compose file and a real deployment are
all the same engine rather than three approximations of one.

It does four things. Register. See your own appointments, invoices,
letters and messages. Book, from the practice's real diary. Cancel.

### It holds no credential

This is the design decision everything else follows from.

The site has no service account and no API key. A patient signs in, their
Directus access and refresh tokens go into an httpOnly cookie, and every
request the site makes to the practice carries *that patient's own token*.
The site is therefore incapable of reading anything the practice has not
already decided a patient may see — not by policy, not by convention, but
because it has nothing to read it with.

That also means the tokens never reach the browser's JavaScript. Every
call happens in a loader or an action, so an injected script on this site
has nothing to steal. The common alternative — access token in
`localStorage`, calls from the browser — is simpler and means one XSS
walks off with a credential that opens somebody's clinical record.

There is exactly one exception, and it is the one that cannot work that
way: registration, which happens before the patient exists. That is
forwarded to the core service, where a separate narrowly-scoped account
lives — see below.

### Booking goes through the same door as the front desk

A patient's booking is written by the core service, back through the
Directus API, with the patient's own token. Nothing about the path is
special. So the create permission applies, the scheduling hook applies,
the availability trigger applies, and the exclusion constraints apply.

Which means a double-book from a phone on a bus is refused by the same
`EXCLUDE USING gist` constraint as a double-book at the desk, and the
patient reads the same sentence the receptionist does:

> Hannah Prins is already booked from Mon 14 Sept, 10:15 to Mon 14 Sept,
> 10:45 — pick another time, chair or clinician.

The suite asserts the two are byte-identical, because "we validate in both
places" is how the two places drift.

Rescheduling is a cancel and a rebook, which is also what a practice does
on the phone — and it puts the slot you are giving up back on the diary
immediately, rather than holding it while somebody picks a new one.

### Registration is not allowed to become a lookup service

The obvious implementation of self-registration answers a question it must
never answer: *is this person a patient here?* It answers it twice — once
by matching an existing record on email and date of birth, and once by
saying "that address is already registered".

So this does neither.

It never matches. A registration always creates a **new** patient record,
marked `pending`, for the practice to merge with whatever they already
hold. That is worse for the patient by one phone call and better for
everyone else, because matching on a birthday is a lookup service for
anybody who can guess one. Claiming an existing record is a real
requirement and it belongs behind an invitation the practice sends to an
address already on the file — not built here, and saying so is more honest
than pretending self-registration covers it.

And it never says an address is taken. A duplicate returns the same shape
as a success. The practice sees two pending records and merges them; an
attacker learns nothing.

The account that does this — `Portal registrar` — can create a patient, a
login, and the single field that links them. It **cannot read either one
afterwards**, which is asserted four ways in the suite: no patients, no
logins, no diary, only the practice list the sign-up form needs.

Create-without-read has one consequence worth knowing about: Directus
answers a create it cannot read back with `204` and an empty body, so
there is no id to return. The service generates the uuids itself and sends
them. Keeping create-without-read is worth that much.

The record is created **before** the login, which is the opposite of the
obvious order and deliberate. If the login is made first and the record
fails, somebody owns an account that signs in to nothing and an address
that can never be registered again — a dead end only a support call
clears. This way a failure leaves a pending record the practice was going
to look at anyway. And it does fail: Directus validates
`directus_users.email` more strictly than the form does, so a domain the
form accepts can still be refused. The registrar can take its own record
back, scoped to one still pending and still unclaimed.

### What the portal policy had to be widened to allow, and why

The Patient policy was read-only on appointments until this site existed.
Four widenings, each named here because a permission model is only
trustworthy if the additions are as visible as the omissions:

- **`appointments` create** — their own row, `status` forced to
  `scheduled` by a preset rather than accepted from the form, clinic
  forced to their own.
- **`appointments` update** — one writable field, validated to
  `status = cancelled`, and only on a row that is theirs, still in the
  future, and not already finished. A patient can call off an appointment;
  they cannot move it onto somebody else's slot or mark it completed.
- **`clinics` read, their own** — every time on the site is drawn in the
  practice's timezone, so the site has to be able to reach it. Scoped by
  `$CURRENT_USER.clinic`, the same expression every staff policy uses.
- **`directus_users` read, the clinicians at their practice** — a patient
  looking at "Tuesday, 09:30, Dr Visser" needs the name. The second arm of
  that filter is the one that matters: portal logins carry a clinic too,
  so a filter that stopped at "same practice" would hand every patient the
  names of every other patient registered there. `role != Patient` leaves
  the staff; the service accounts are already out, having no clinic.

Plus their own row for one column, `clinic`, because the core service
decides which diary a caller may read from it and asks with the caller's
own token. Without that, Directus answers `/users/me` with `id` alone —
**it does not refuse an un-permitted field there, it silently drops every
other field in the list, including the permitted ones** — and a patient is
told their account is not attached to a practice while looking at that
practice's name.

Consent moved too: `allow_email`, `allow_sms` and `allow_whatsapp` are now
readable and writable by the patient. It is their consent, and a portal
that displays a preference it will not let you change is worse than one
that never mentions it.

### A bug this found

`access_log.patient`, `.clinic` and `.user` are all declared
`ON DELETE SET NULL`. A `SET NULL` cascade is an **UPDATE**. The
append-only trigger refused every update on the audit table.

So any patient who had ever been *read* could no longer be deleted, and
the refusal surfaced as a 500 saying `ENAMEL_LOG_IMMUTABLE` on a request
that never mentioned the log. The audit table had quietly become the thing
that decided whether a clinical record could be erased — right-to-erasure
lost to a trigger written for an unrelated reason, with no error anybody
would connect to the cause.

The trigger now compares the row as a whole with those three keys removed,
and allows a key to go from set to NULL and never the other way. A column
added to that table later is immutable by default, which is the safe
direction to be wrong in. Both halves are asserted: the row must outlive
the patient, and its content must still be unchangeable.

## The medico-legal layer

This one replaced something that was wrong: a mutable free-text
`clinical_notes` field on the patient, which is exactly the shape
record-keeping guidance rules out.

Worth getting the citation right, because the internet gets it wrong. The
**GDC** requires records to be "contemporaneous, complete and accurate"
(standard 4.1) and requires amendments to be "clearly marked up and dated"
(4.1.5) — but Principle 4 says nothing at all about deletion. The
append-only requirement comes from **FGDP(UK)**, which asks for "a full
audit trail facility... to prevent the overwriting, erasure or corruption
of data", entries signed off and locked, and — where a correction cannot be
made before locking — "an entry should be inserted as soon as any error is
discovered, drawing attention to the original entry and error", with void
entries remaining printable.

So notes are **entries, never edits**. A correction is a new entry that
points at the one it corrects, carries a reason, and leaves the original
legible. That is the paper convention — a single line through the error,
initialled — expressed as a schema. The seed ships a real one: an
examination note with a transposed tooth number, and the amendment the
next morning that says so without touching it.

And append-only is enforced rather than agreed: **no policy grants
`update` or `delete` on notes, histories or consents — including the
practice owner's** — and a check asserts that no such rule exists. It is
the one place in this project where the owner is deliberately not
omnipotent.

### Medical history is two things

A **signed snapshot** on a date, and the **current state** a clinician
acts on. Both, not one. Updating a history does not edit it — it produces
a new dated copy for the patient to sign, and FGDP 8.9.1 is blunt about
why: "The system should NOT delete the previous medical history." The seed
has a patient whose history changed materially — stopped smoking, started
apixaban after an AF diagnosis — and both versions survive, the older one
pointing forward to its replacement.

The current state lives in `patient_findings`: allergies, medications and
conditions as filterable rows rather than a paragraph, each with a
two-state status. An allergy withdrawn on review goes **inactive, not
away**, because the fact that it was once believed is part of the record.
Answers are three-valued — yes, no, **unknown** — because unknown is what
changes the plan for an extraction, not a missing value.

Reception sees *that* a patient has an active allergy, because a
penicillin allergy on the day list is safety. They cannot read its
severity, its note, any clinical note, or any history — and requesting one
of those fields by name returns 403 rather than quietly omitting it.

### Consent stores the answers, not the PDF

The instinct is to keep the document you printed. Open Dental does the
opposite and is right: it retains the structured answers with a signature
"electronically linked to the data it applies to", and the signature is
**invalidated if that data changes**. A rendered PDF cannot do that — it
goes stale in silence, and you find out during a complaint.

So `data_fingerprint` binds the signature to the text it signed. Change the
risks that were discussed and the fingerprint no longer matches, which
marks the signature invalid instead of leaving it attached to something
else. Linkage to a treatment plan is optional, not intrinsic, because a
consent form only carries procedures when its template asks for them.

## Treatment planning, and why one number is a lie

A treatment plan is not a filter over procedures with a "planned" status —
that is the thing it gets mistaken for. It is a record with a three-value
status and real transitions: promoting an inactive plan demotes the active
one.

| | |
|---|---|
| `active` | Exactly one per patient. Supplies the defaults for the chart and for booking |
| `inactive` | As many as you like — alternatives, superseded versions, the cheaper option the patient is mulling |
| `saved` | A permanent snapshot. **Signing one freezes it**: its procedures cannot be edited until the signature is cleared |

"Exactly one active per patient" is a partial unique index — `UNIQUE
(patient) WHERE status = 'active'` — which Directus cannot create through
its API. It is enforced by whoever promotes a plan and **asserted by the
verify suite**, which is the honest position: stated, tested, and not
pretended to be a database constraint.

### The presented total is frozen, and that is the point

Case acceptance by value is `accepted ÷ presented`. If "presented" is
recomputed from today's fee schedule, every price rise silently rewrites
last year's acceptance rate. So the amount the patient was actually shown
is stored, at plan level and per item, and never recalculated.

**No percentage is stored anywhere**, which is the part worth arguing
about. Both a value-based and a count-based rate matter, and the *gap
between them* is the diagnostic signal: a count rate much higher than the
value rate means the expensive cases are the ones being declined. A single
blended figure throws that away. The seed makes it visible —

```console
Kadehuis case acceptance —
  by value: 24.1%  (€1225.00 of €5085.00)
  by count: 45.5%  (5 of 11 procedures)
```

— and a check asserts the two disagree, so the day someone "simplifies"
this into one column, the suite says so.

For calibration, since the numbers get quoted loosely: observed averages
run ~50–60% count-based and ~35–45% value-based, and the widely repeated
"75–80%" high-performer target has no primary ADA source behind it. That
asymmetry is normal, not a problem to be fixed.

Priority is free text capped at seven characters, not an enum, because
Open Dental's priorities are a user-editable list accepting "numbers,
letters or words up to 7 characters" — a practice may run 1/2/3, or A/B/C,
or URGENT.

Reception reads plans and cannot write them: quoting from a plan and
booking its procedures is their job, proposing treatment is not. A patient
sees their own active plan and what it costs, and is not shown the
superseded alternatives — checked with a patient who has both, because a
portal assertion against a patient with no plans passes without proving
anything.

## Recall, and the field everyone forgets

The module a dentist looks for first and hobby schemas leave out, because
it is the commercial heart of a practice: who is due, who is overdue, who
has been chased and how. Three collections, and every division comes from
how real products behave rather than from taste.

**The interval is not a free number.** NICE CG19, verbatim: "the patient
should be assigned a recall interval of 3, 6, 9 or 12 months if he or she
is younger than 18 years, or 3, 6, 9, 12, 15, 18, 21 or 24 months if he or
she is aged 18 years or older." So the domain is 3-month steps, floor 3,
ceiling 24 — and 12 for under-18s, which is an age-conditional bound the
field validation cannot express, so the message says so instead of
pretending. The US has no equivalent: the ADA states of periodontal
maintenance that "no time frame is outlined in the CDT", and the
3-month convention is payer practice, not a standard. A US deployment
should relax this rule, not copy it.

**The field everyone forgets.** NICE again: "The dentist should discuss the
recommended recall interval with the patient and record this interval, *and
the patient's agreement or disagreement with it*." Three values, not a
nullable boolean — "not discussed" is a different fact from "disagreed",
and a null in a two-valued column makes the reader guess which. One seeded
patient asked for annual reviews against clinical advice, and the record
says so.

**Two due dates, on purpose.** Open Dental distinguishes a calculated due
date — previous visit plus interval — from an actual one that "typically
matches the calculated due date but can be manually adjusted". Collapse
them and you lose the ability to say *this patient is being seen early,
deliberately*. A check asserts the two differ on the recall that was
brought forward three weeks.

**Status is the practice's vocabulary, not mine.** Open Dental stores it as
a foreign key into a user-editable list, and its shipped examples are
contact attempts: "Mailed postcard", "Texted". A `CHECK` enum here would be
a guess about somebody else's workflow, so `recall_statuses` is a
collection. Same for `recall_types` — practices invent their own kinds. The
one closed axis is the *special type*, which has exactly four values
because it drives behaviour: a child prophylaxis series is not
interchangeable with an adult one.

**Three ways to suppress, none of them delete.** A patient who moved away,
one mid-treatment, and one in arrears are all excluded from a recall run:
`is_disabled`, `disable_until` a date, and `disable_until_balance_under` an
amount. The history stays, because they may come back. Both worklist
bookmarks honour all three in their filters rather than in application
code — "overdue" is `date_due` against `$NOW`, resolved per request, never
a stored state.

What the platform would not do: keeping the calculated due date in step
needs `previous + interval`, and a Directus flow cannot add an interval to
a date. There is no arithmetic without the script operation, and that
operation is inert in this image. In production it would be a generated
column; here the writer sets it, and the code says why.

## Fewer teeth, more teeth, and neither

A chart with 32 boxes for an adult and 20 for a child, chosen from the date
of birth, is wrong in three separate directions. This is the part of the
project I would want a dentist to read.

### Fewer

Tooth agenesis is ordinary. Excluding third molars, pooled prevalence of
hypodontia is around 6% of people; the third molars themselves are absent
in **23%**. Among affected people the commonest absentees are the
mandibular second premolars — 35 and 45 — at **29.9%**, then the maxillary
lateral incisors (12, 22) at 24.3%, then the maxillary second premolars
(15, 25) at 13.7%. About 42% are missing exactly one tooth.
[Polder et al. 2004](https://doi.org/10.1111/j.1600-0528.2004.00158.x),
third molars excluded.

And *why* it is absent is a different fact from *whether*, with
consequences. ICD-10-CM K00.0 carries an Excludes1 against K08.1-, meaning
congenital absence and acquired absence must never both be coded. An
insurer's missing-tooth clause turns the answer into money. A paper chart
puts one X through the tooth and loses all of it.

### More

Supernumerary teeth do not fit in FDI notation at all, and the reason is
worth quoting. ISO 10394:2023, introduction:

> ISO 3950 has assigned a meaning to most of the available combinations of
> two digits. As a result, ISO 3950 cannot be [expanded] to satisfactorily
> identify supernumerary teeth without introducing significant changes to
> its structure.

One of its stated design requirements is that it "does not assign a new
meaning to designations that exist in ISO 3950" — so the schemes you meet
in the wild that recycle two-digit codes for extra teeth (19, 29, 2.9) are
contrary to the committee's explicit intent.

ISO 10394 uses letters instead: **A1–A8** upper right, **B1–B8** upper
left, **C1–C8** lower left, **D1–D8** lower right, plus two midline codes —
**AB** in the maxilla and **DC** in the mandible. `DC`, not `CD`: the
letters flanking each midline are read in arch order. A mesiodens, the
commonest supernumerary in the permanent dentition, is `AB`. Not 11, not
21, not a flag on tooth 11.

Two consequences land directly in the schema:

- The standard "does not classify supernumerary teeth as deciduous or
  permanent", so there is one code set spanning both dentitions rather
  than FDI's 1–4 / 5–8 split.
- "When multiple supernumerary teeth are present in the same location, the
  same code is used for the designation of each of those supernumerary
  teeth." A designation is **not unique**. A double mesiodens is two teeth
  both called AB, and `UNIQUE (patient, designation)` would reject a real
  mouth. There is no such constraint here, and a check asserts that the
  second AB is accepted.

Which is also why the column is a `string`. It used to be an `integer`,
and an integer cannot hold `AB`.

### Neither

Age does not tell you which dentition a tooth belongs to. Eruption timing
varies enough that deriving it would misclassify a large fraction of
perfectly normal children, and a retained primary molar in a forty-year-old
is still charted with its primary designation. Real products agree on this
by disagreeing with each other: Open Dental derives dentition from nothing,
Dentrix uses an exclusive per-position toggle a clinician sets by hand, and
Carestream SoftDent carries both a primary and a permanent tooth at the
twenty succedaneous positions — only twenty, because the twelve permanent
molars have no primary predecessor to replace.

So [`dentition`](../apps/directus/bootstrap/src/schema/dentition.ts) is recorded state, one
row per tooth somebody has actually looked at. `present`, `unerupted` and
`absent` are three states rather than two — an unerupted tooth is *there*,
and charting it as missing throws away the finding the radiograph was taken
for. Absence carries a reason. A deciduous tooth carries whether it is
retained. And every row carries when it was assessed and from what, because
a tooth cannot be called never-formed before the age it would have begun to
calcify: the date is what separates a finding from a guess.

The absence of a row means "not assessed", which is not the same as "not
there" — a distinction the radiograph is entitled to make and the calendar
is not.

The seed ships four mouths that a fixed chart cannot hold: bilateral
agenesis of 35 and 45 with the primary molar retained above, a double
mesiodens (one erupted, one lying horizontally), a child mid-transition
with permanent incisors through and premolars still developing, and a
47-year-old with a sound deciduous 55 because 15 never formed.

### The notation trap

A bare two-digit tooth code is ambiguous, and the collision is nastier than
it looks. The US Universal system numbers supernumerary permanent teeth
**51–82** — the same integers ISO 3950 uses for deciduous teeth. `51` is an
upper-right deciduous central incisor in one system and a supernumerary
behind tooth 1 in the other, and nothing in the value says which. Every
tooth reference here is documented as ISO, and the validation message names
both standards rather than leaving a reader to assume.

## How the repository is laid out

```
apps/
  directus/
    bootstrap/     provisioning: schema, database rules, policies, flows, branding, i18n, the checks
    extensions/    seven Directus extensions — tooth chart, scheduling rules, day sheet, governance/audit, practice report, documents, queues
  core/            NestJS + BullMQ: slot search, messaging, reports, DICOM headers, integrations
  public/          the patient site — React Router v7 in workerd
packages/
  time/            wall-clock arithmetic in a practice's own timezone
  extension-ui/    the one empty/loading/refused state every extension renders
scripts/
  screenshots.mjs  rebuilds the six images this README embeds
  setup.sh         clean checkout to a running, seeded, verified practice
  teardown.sh      hands the licence activation back, then destroys the stack
  backup.sh        encrypted dump + file library
  restore.sh       puts one back, HMAC checked before anything is decrypted
  restore-test.sh  proves a backup restores, into a scratch database
```

A pnpm workspace, and the reason is `packages/time`. The same forty lines
of timezone handling existed three times — in the seed, in the core
service and in the day-sheet extension — because there were three
independently built packages and nowhere to put shared code. A calculation
whose failure mode is *silent*, every appointment an hour out with nothing
throwing, is the worst possible thing to have three copies of.

One `docker-compose.yml` at the root brings up all of it: Postgres, Redis,
Mailpit, Directus, the core service and the patient site.

## What's in the box

| | |
|---|---|
| **46 collections** | practice (a singleton), rooms, patients, appointments, treatments, treatment_records, tooth_conditions, dentition, clinical_notes, medical_histories, patient_findings, consents, perio (screenings, sextants, exams, teeth, sites), treatment_plans (+ items), recalls (+ types, statuses), payment_plans (+ charges), waiting_list, laboratories, lab_cases, documents, invoices, invoice_lines, payments, ledger_exports, messages, clinic_hours, practitioner_hours, absences, room_closures, access_log — the governance registers: retention_rules, data_breaches, disposals, processing_purposes, consent_records — and services, faqs and pages for the practice's own website |
| **12 policies / 10 roles** | practice owner, dentist, hygienist, front desk, patient portal — plus four service accounts that each hold exactly one job: the reminder sweep (reads the diary, sets one boolean), the portal registrar (creates a login, reads nothing), the website reader (published content, refused on nine clinical collections) and the inbound webhook — and a queue operator, which opens the job board and not one clinical collection |
| **12 global bookmarks + 45 default views** | plans awaiting an answer, recalls overdue, recalls due, today's diary, my schedule, needs a reminder, no-shows, unpaid invoices, new patients, treatment plans, work completed today, medical alerts (dentists) — and a designed list layout for every collection |
| **10 database constraints + 6 triggers** | two exclusion constraints that make double-booking a dentist or a chair impossible for *any* client; a trigger holding every appointment against opening hours, the rota, leave and chair downtime; an append-only guard on the audit log; invoice totals; and two that hold the governance registers — the Article 33 clock, and a disposal that cannot have been carried out before it was authorised |
| **5 flows** | appointment reminders (hourly, fanned out one flow per patient), overdue invoices (nightly), and two that classify document files. Invoice totals used to be two more and are now a database trigger — see below |
| **7 extensions** | the FDI tooth chart; a scheduling hook that turns a constraint violation into a sentence, and refuses a patient booking on somebody else's record; the day sheet — chairs across the top, time down the side, drag to reschedule; a governance hook recording the reads and failed sign-ins Directus does not, and holding the breach and disposal rules; the practice report; the documents bundle — a radiograph viewer that adjusts without altering, and the rules that keep a version chain honest; and Queues, whose only job is to open the job board with the token your browser already has |
| **1 service** | `core`, a NestJS + BullMQ service: slot search across five tables, messaging that retries and can be seen to have failed, every ratio the reports need, DICOM headers, the one account that can create a patient login, the subject access export, the retention review, and the integration adapters |
| **7 integration adapters** | a double-entry journal CSV, a printable lab docket and an iCalendar feed (all real, no account anywhere); a desk terminal that records what a person took; Stripe PaymentIntents, off by default; and two honest mocks whose references are visibly prefixed `mock:`. Three messaging channels alongside them — SMTP, Twilio, Meta's WhatsApp Cloud API — selected by environment variable |
| **1 patient site** | `public`, React Router v7 in workerd: register, see your own record, book from the real diary, cancel. Holds no credential of its own — every call carries the patient's token out of an httpOnly cookie |
| **Full branding** | logo, favicon, login screen and admin theme, applied as code |
| **4 languages** | English, German, Dutch, French — collections, fields, notes, dividers, status labels, bookmark names, and the chart extension's own UI |
| **Field validations** | FDI tooth numbers, email and phone shapes, non-negative prices, VAT bounds, no future birth dates |
| **Backups that restore** | encrypted dump + file library, and a restore test that rebuilds into a scratch database and asserts the rows, the named records, the constraints and the triggers — then tries a double-booking against the restored copy to prove they still fire |
| **Demo data** | 2 practices, 8 staff + 2 portal logins, 24 patients, 48 appointments, 129 tooth findings, 16 invoices, 8 patient documents, a full seven-day rota per practice, 2 absences and a chair out of service |

### Multi-tenancy

Every collection carries a `clinic`, and `directus_users` gains one too. Every
policy filter compares the two:

```ts
const ownClinic = { clinic: { _eq: "$CURRENT_USER.clinic" } };
```

Creates are stamped with `presets: { clinic: "$CURRENT_USER.clinic" }`, so a
user cannot plant a row in someone else's practice either. No application code
is involved, which means no application code can forget.

### Patient documents, and the file library

Radiographs, referral letters, signed consent and lab reports. The interesting
part is not the collection — it is that `directus_files` needed a tenant
boundary of its own, and that getting it wrong is easy in a way worth writing
down.

The first attempt scoped the `documents` collection by `kind`, so reception saw
referrals and consent and never a radiograph. It looked right. It was not: a
document row hands out a file uuid, and `/assets/<uuid>` answers on
`directus_files` alone. Reception could not see a radiograph in any list and
could open every one of them by URL. `pnpm verify` caught it on the first run.

The obvious fix does not work either, and the reason is the useful part:

```ts
// Cannot work. A relational filter inside a permission is evaluated with
// the caller's own visibility — reception cannot see radiograph documents,
// so "no radiograph document points at this file" is true for them about
// every file in the building.
{ documents: { _none: { kind: { _in: ["radiograph", "photograph", "lab_report"] } } } }
```

So the marker lives on the file. `directus_files.document_kind` is a plain
string copied from the document that references it, and reception's permission
filters on that — no subquery, nothing to evaluate through a permission the
caller does not have. Two flows keep it in step, one per event shape, and both
run `permissions: "$full"`, because an event flow inherits the accountability of
whoever triggered it and no clinician may write a readonly system field. That
one cost an afternoon: the flow ran, was refused, and left the file open.

What it adds up to, all of it asserted in the suite:

| | |
|---|---|
| Front desk | referrals, consent and correspondence. Cannot list a radiograph, cannot open one by URL |
| Hygienist, dentist, owner | everything in their own practice, images included |
| Another practice | `403`, on the row and on the asset |
| A patient | their own consent form and letters — not their own radiographs, and not anyone else's anything |
| The brand kit | belongs to no practice, stays readable by everyone, or the admin shell loses its own logo |

### Global bookmarks

Defined once with `role: null`, so every user sees them — narrowed by whatever
their own policies allow rather than duplicated per role. Filters use `$NOW` and
`$CURRENT_USER`, which resolve per request, so "Today's diary" stays correct
without a job rewriting it.

### Flows, and what the platform will not do

Five flows, and the interesting part is the three things that had to be
worked around. All of it is in [`flows.ts`](../apps/directus/bootstrap/src/flows.ts), tested
by running them rather than by reading them.

**There is no loop inside a flow.** Reminders need one email per patient,
and a flow is a single chain. The `trigger` operation runs *another* flow
once per element of an array, so the per-patient work is its own flow and
the hourly one just hands over the list — `iterationMode: "serial"`,
because a hundred concurrent sends is how a practice gets rate-limited.

**`$NOW` is a filter variable, not a payload one.** Writing
`{ reminder_sent_at: "$NOW" }` sends Postgres the literal string `$NOW`
and the update fails with a parse error. Nothing in a flow can produce the
current time without the script operation, which is inert in this image —
so the field is a boolean, `reminder_sent`, and `date_updated` records
when.

**`item-update` with an empty `key` is a loaded gun on 11.** Read the rows,
feed them to an update, and on a night with nothing to do the key collapses
to empty — which on 12.3.0+ is a harmless no-op, and on 11 falls through to
updateByQuery with an empty query and rewrites every row in the collection.
The nightly overdue flow is therefore one query-scoped update and no read
at all. An empty match updates nothing; that is the whole point.

One more worth knowing, because it changes what a green flow means: the
mail operation calls `send()` without awaiting it and swallows the
rejection into a log line. It resolves whether or not anything was
delivered. Mail goes to [Mailpit](http://localhost:8025) here so you can
see for yourself rather than trust the flow.

## Validation lives in the schema

Rules are on the fields, so the API enforces them whatever writes to it —
the admin, an import script, or a frontend you have not written yet:

```console
$ curl -X POST … -d '{"tooth_fdi": 19, "condition": "caries"}'
{"errors":[{"message":"Validation failed for field \"tooth_fdi\". Value has to be one of […]"}]}
```

FDI numbering is not a contiguous range — 19, 20, 29 and 30 do not exist — so
tooth fields validate against an explicit list rather than `_between 11 and 48`,
which would quietly accept nonsense. Prices cannot be negative, VAT is bounded
to 0–100, chair time to 5–480 minutes, and a date of birth cannot be in the
future.

## Four languages, end to end

<p align="center">
  <img src="docs/screenshots/admin-nl.png" alt="The Enamel admin in Dutch, as the Kadehuis practice owner sees it" width="900">
</p>

English, German, Dutch and French — and not just collection names. Field
labels, field notes, section dividers, status choices and bookmark names are
all translated, because a receptionist in Rotterdam reading "Medical alerts"
in English defeats the point.

Directus has three separate translation mechanisms and
[`i18n/`](../apps/directus/bootstrap/src/i18n) uses all of them:

| Mechanism | Used for |
|---|---|
| `directus_collections.translations` | Collection names, with singular *and* plural — German and Dutch inflect differently from English |
| `directus_fields.meta.translations` | Field labels |
| `directus_translations` + `$t:key` | Everything with no translations array of its own: bookmark names, field notes, divider titles, status labels |

Labels are keyed by field name, because `patient`, `status` and `notes`
mean the same thing everywhere they appear — translated once, applied
wherever they occur.

That was the whole story until a register's first column started reading
**"Patiëntnummer"** — patient number — in Dutch. `reference` is a patient
number on `patients`, a batch reference on `ledger_exports` and a case
reference on `data_breaches`, and nothing errored: the column simply said
something untrue, in three languages, on a compliance document. So there
is now a `collection.field` override map, checked first, for the handful
of names that do not mean one thing.

679 keys across 4 languages — 2,716 rows — plus 46 collection names and
385 field labels.

Every collection and field **note** is a key, and so is every placeholder
that is a *hint*. That was not true until recently: two field notes and
fourteen collection notes sat in English on forms that were otherwise
fully translated. Nothing reported them, because the check that existed
asked whether every `$t:` reference resolved — and a bare English literal
is not a reference, so it had nothing to say. They were found by reading a
Dutch screenshot. The suite now asserts the inverse as well.

Placeholders stop at the hint. `Antistolling, latexallergie, pacemaker…`
is an instruction and translates; `36` is a tooth number,
`kadehuis.example.com` is a host and `WGBO, Art. 7:454 BW` is a citation,
and those are the same string in every language. That line is a judgement
rather than a rule, which is why the suite asserts notes and not
placeholders.

<p align="center">
  <img src="docs/screenshots/tooth-chart-nl.png" alt="The tooth chart in Dutch, including a supernumerary tooth" width="900">
</p>

`$t:` reaches less than you would hope, and the boundary is worth knowing
before you design around it. Tested against 12.3.1, these four render the
literal string `$t:your_key` on screen: **folder names**, **file titles**, the
**project descriptor**, and the **login note**. So the one word naming the
brand folder has to work in all four languages by itself, and the sign-in
message stays English.

They also do not reach strings compiled into an
extension, so the tooth chart ships its own table
([`messages.ts`](../apps/directus/extensions/directus-extension-tooth-chart/src/messages.ts))
covering condition names, tooth anatomy, arch labels and error states, and
reads only the active locale from the app. Regional variants fall back by
language subtag, so `de-AT` reads German rather than English.

## Why this provisions rather than syncs

Directus 12.3.0 shipped `@directus/cli` (`d6s sync pull | diff | push`),
which finally moves configuration between instances — roles, policies,
access, permissions, flows, operations, dashboards, panels, settings and
translations, on top of the schema. That is the right tool for promoting
staging to production, and it did not exist when this was written.

It is not the right tool for *this* repo, for three reasons:

- **It syncs between two live instances.** Enamel's claim is `git clone`
  → running practice, from nothing. There is no source instance to pull
  from.
- **It skips two things this project needs.** `directus_presets` is out
  of scope, so the twelve global bookmarks would not travel. And settings
  sync deliberately strips `project_logo`, `public_favicon`,
  `public_background` and `public_foreground`, because `directus_files`
  is not synced — so the whole visual identity would arrive blank.
- **Both ends must run the same patch version of 12.2+**, on the same
  database vendor — so a sync cannot cross a major version at all, and
  the CLI does not exist on 11. This code does cross it: the same source
  provisions 11.17.4 and 12.3.1, green on each. Version portability is
  the property a dump cannot have, because a dump is a snapshot of one
  server's internals and this is a description of what you want.

The classic `/schema/snapshot` has never covered any of this: it is
collections, fields and relations only, and that is unchanged from
11.17.4 through 12.3.1.

So the trade is deliberate. Declarative TypeScript against the REST API
covers everything — schema, access, bookmarks, flows, branding files,
translations — from an empty database, and stays readable as a diff.
Environment Sync is the better answer once there are two environments to
keep in step; on a project with real staging and production I would use
both, sync for promotion and this for the initial stand-up.

## Directus 12

This runs **Directus 12.3.1**. It works, with one prerequisite worth
stating plainly.

12.x gates custom rules on access policies behind a licence, and every
filter and field restriction here is such a rule. On an **unlicensed**
12.x, provisioning fails ~90 times with:

```
custom_permission_rules_enabled is a restricted resource.
```

That is not a degraded access model — it is no access model. So `pnpm
setup` checks entitlements before provisioning and stops with an
explanation rather than letting you read ninety identical errors.

Two ways past it:

- **A free Open Innovation Grant key** — under $5M revenue and under 50
  employees. Set `DIRECTUS_LICENSE_KEY` in `.env`; the server activates it
  on boot and stores the token. Activation is silent, so check
  `GET /license` for `status: active` rather than the logs, and recreate
  the container if a first attempt fails.
  [Details](https://directus.com/docs/licensing/open-innovation-grant).
- **`DIRECTUS_IMAGE=directus/directus:11`** — 11.17.4 has no such gate.

Both are tested from an empty database: the access-model half passed
21/21 on a clean 12.3.1 with an OIG key, and 21/21 on 11.17.4 with no key
at all. Those are the figures those runs measured, and they are left as
measured.

The whole suite — all 142 — has since been measured the same way: an empty
data directory to `142/142`, in one `./scripts/setup.sh`, on
`directus/directus:11`.

That took longer to arrange than it should have, because `docker compose
down -v` does not remove a bind mount and the database lives in one. Every
"clean" run before this had the previous run's tables still underneath it,
and two bugs were hiding behind that: the migration step aborted outright
on a database with no collections in it, and a fresh clone had therefore
never actually been proven to work. Both are fixed, and `teardown.sh`
removes the directory now.

### What else changed, measured rather than assumed

- The tooth-chart interface **loaded and enabled on 12.x while declaring
  `host: ^11.0.0`** — that range drives a Marketplace compatibility
  warning, not a load-time gate. It now declares
  `^11.0.0 || ^12.0.0`, which is honest about where it has been run
  rather than relying on the gate being absent.
- Migrating an 11.17.4 database in place to 12.3.1 kept all 21 access
  checks passing; no data work was needed.
- **Two theme keys moved, and Directus does not tell you.** An unknown
  theme key is accepted and ignored, so a stale name looks exactly like a
  working one — these were silently dead until a screenshot gave them
  away. `navigation.background` is now `navigation.list.background`, and
  `navigation.project.background` is gone: the project tile takes
  `shell.background`, which paints the *entire* shell, so a teal tile
  costs you a teal application. Corrected against the variables the
  12.3.1 admin bundle actually emits, with `shell.background` left alone.
  The custom CSS keeping the project descriptor readable now reads
  `--theme--navigation--project--foreground` rather than hardcoding white,
  which was right while the tile was teal and invisible in light mode the
  moment 12 stopped painting it.
- **12.3.0 changed Update/Delete Items flow operations**: with empty
  targeting they now return null instead of acting on the whole
  collection. Nothing here depends on that; a flow written against 11
  might.

### Environment Sync

12.3.0 shipped `@directus/cli` (`npx @directus/cli`, binary `d6s`), which
syncs roles, policies, access, permissions, flows, operations, dashboards,
panels, settings and translations between instances. It is a client-side
package, not part of the server image.

It is the right tool for promoting staging to production, and still not a
substitute for this repo — see *Why this provisions rather than syncs*.

## Running it

```bash
git clone https://github.com/khanahmad4527/enamel && cd enamel
./scripts/setup.sh            # or: pnpm setup
```

That is the whole thing: it writes `.env` with a fresh `SECRET` and
generates the two secrets nothing can start without, builds the shared
package and the five extensions, starts Postgres, Redis, Mailpit,
Directus, the core service and the patient site, checks the licence
entitlements, provisions, seeds, and verifies. Re-running is how you pick
up a change — every step is idempotent, so the second run creates nothing
and skips ~200 things.

Everything in this README has been run from an empty database, not from
the instance it was developed on. `./scripts/teardown.sh --force` really
does remove the database directory — it once printed "Gone" over a live
one, and every "clean" run for weeks had old tables underneath it. A warm
database hides ordering bugs, and two were sitting behind that one.

On Directus 12 there are exactly two values to set in `.env` first, and the
script stops and names both if you have not:

- `DIRECTUS_LICENSE_KEY` — 12.x refuses custom rules on access policies
  without one, and those rules are the whole project. An
  [Open Innovation Grant](https://directus.com/docs/licensing/open-innovation-grant)
  key is free under $5M revenue and 50 employees. Or set
  `DIRECTUS_IMAGE=directus/directus:11` and skip the question.
- `PROJECT_OWNER_EMAIL` — Directus 12 asks for one the first time you sign
  in, and setting it here answers that dialog instead of meeting it later.

Once it finishes, the two things worth opening are
`http://localhost:9056/admin` — the practice's own system — and
`http://localhost:8058`, which serves both the practice's public website
and the patient area behind it. Sign in to the admin as
`desk@kadehuis.example.com`, open Day sheet, and note a free slot. Then
sign in to the patient site as `patient@kadehuis.example.com` and book
it. Then go back and try to book it again from the desk. Same constraint,
same sentence, different building.

#### The websites

Two practices, one installation, told apart by the address:

| | |
|---|---|
| `http://localhost:8058/` | the chooser — only ever seen without a domain |
| `http://localhost:8058/kadehuis` | Kadehuis Dental, Amsterdam (teal) |
| `http://localhost:8058/marina` | Marina Smile Clinic, Dubai (amber) |
| `…/services`, `…/team`, `…/contact` | what they offer, who works there, when they are open |
| `…/privacy` | the privacy notice, **generated from the practice's own retention rules** |
| `/sitemap.xml`, `/robots.txt` | built from what is published, not from a list |

In a deployment each practice answers on its own domain and the prefix
disappears; the path is how one host stands in for DNS. It is the same
route either way — try it:

```bash
curl -s -H 'Host: kadehuis.example.com' localhost:8058/ | grep -o '<title>.*</title>'
```

Worth comparing the two privacy notices side by side. Kadehuis keeps a
dental record for twenty years under the Dutch WGBO; Marina keeps one for
twenty-five under UAE Federal Law No. 2 of 2019. Neither number is
written on the page — both are read from `retention_rules`, which is
what stops a published notice drifting from the policy it describes.
Change the row in the admin, reload the page, and the notice says
something else.

**Tear down with `./scripts/teardown.sh`, never `docker compose down -v`.**
A licence key allows a limited number of activations and a fresh database
claims one on boot; wiping the volume strands the old activation, because
the licence server is never told. Rebuild a few times that way and the key
stops working, with `FATAL: Activation limit exceeded` at boot. The
teardown script deactivates first, which gives the activation back.

### Step by step, if you would rather see it

```bash
cp .env.example .env          # then set SECRET, DB_PASSWORD, ADMIN_PASSWORD

# Extensions are compiled output and are not committed, so build them
# first — Directus loads whatever is in extensions/ at boot. Without this
# the patient form shows a missing field, the scheduling rules do not
# apply, and the day sheet is not in the module bar.
pnpm install                  # one workspace install
pnpm build:packages           # @enamel/time, which the extensions import
pnpm build:extensions

docker compose up -d          # Postgres, Redis, Mailpit, Directus, core

pnpm provision                # schema, database rules, policies, bookmarks, flows, branding, translations
pnpm seed                     # ... plus two practices of demo data

# The seed generates the reminder sweep's token into .env, and the
# container read that file before it existed. Without this the reminder
# sweep runs with no credential.
docker compose up -d --force-recreate --no-deps core

pnpm verify                   # prove the access model and the scheduling rules hold
```

Or, from the repo root, the same thing as scripts: `pnpm build:extensions`,
`pnpm up`, `pnpm provision`, `pnpm seed`, `pnpm verify`. `pnpm reset` is a
teardown followed by a setup, and goes through the deactivation.

Admin at **http://localhost:9056** (the port is `DIRECTUS_PORT`; 8055 is often
already taken by another Directus). The core service answers on
**http://localhost:8057/health**, and `pnpm logs:core` follows it.

#### The queue board

Bull Board is at **http://localhost:8057/queues**, and opening that link
directly is meant to fail. Open **Queues** in the Directus sidebar instead.

There is no second password, and there is no token in the URL. The Directus
module hands the core service the token your browser already holds; the
service asks Directus whether you are an administrator and answers with a
**single-use ticket** good for about a minute. Visiting it exchanges the
ticket for a first-party session cookie and redirects the ticket out of the
address bar, so the link left in your history is already dead. The same link
a second time is a 401.

Administrators only, and that is not caution. One `reminders` queue holds
jobs for every practice on the installation, and a payload looks like this:

```json
{ "patientName": "Meera Meyer", "email": "meera.meyer@example.com",
  "practiceName": "Marina Smile Clinic", "practitionerName": "Omar Rashid",
  "localWhen": "Tuesday 15 September at 10:00" }
```

BullMQ has no notion of a tenant to filter by, so there is no version of
that page scoped to one practice — a practice owner is refused rather than
shown a board with somebody else's patients on it. Splitting the queues per
tenant would fix it and cost a queue per practice per channel, all polled;
the road not taken is written down rather than left implied.

`QUEUE_BOARD_ENABLED=false` removes the page entirely. Nothing about
delivery depends on it.

`scripts/setup.sh` does all of the above in order, including the restart,
and ends by running the suite. It is what the 167/167 above was measured
from — a clean database to a working practice in one command.

### Answering a subject access request

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8057/api/subject-access/<patient-id>
```

Everything held about one person — 27 sections, from the chart and the
clinical notes to the invoices, the messages and the log of who looked —
with the Article 15(1) information that has to accompany it: the legal
basis, who else sees it, where it came from, **the actual retention period
read from `retention_rules`**, and that nothing about them is decided
automatically.

Two things about it are worth more than the endpoint.

**It runs as the caller.** No service credential, so it cannot become a
way around the permission model — which is the shape a subject access
export naturally wants to take. Try it as `desk@kadehuis.example.com` and
it answers **409 with the list of parts reception cannot read**, rather
than a document with silent holes in it that would be handed to a patient
as their complete record.

That design answered a question instead of confirming one: the person who
can produce a complete response turns out to be the **practice owner**. A
clinician is refused too — payments and the access log are not theirs.

**It logs itself.** The export is a read of the patient's entire record,
so it writes its own `export` row to the access log before the bytes
leave. It would otherwise be the one read in the system that left no
trace.

### Demo logins

All use the password `EnamelDemo!2026`. Log in as two of them side by side —
that is the fastest way to understand the access model.

| Role | Kadehuis Dental | Marina Smile Clinic |
|---|---|---|
| Practice owner | `owner@kadehuis.example.com` | `owner@marina.example.com` |
| Dentist | `dentist@kadehuis.example.com` | `dentist@marina.example.com` |
| Hygienist | `hygienist@kadehuis.example.com` | `hygienist@marina.example.com` |
| Front desk | `desk@kadehuis.example.com` | `desk@marina.example.com` |
| Patient portal | `patient@kadehuis.example.com` | `patient@marina.example.com` |

## Why provisioning is code, not a snapshot

The usual way to share a Directus schema is `directus schema snapshot`, which
produces a YAML blob nobody can read or review. Everything here is declarative
TypeScript instead — [`schema/`](../apps/directus/bootstrap/src/schema) describes intent,
[`apply.ts`](../apps/directus/bootstrap/src/apply.ts) turns it into API calls.

Every operation is idempotent, so re-running is how you pick up a change:

```console
$ pnpm provision
  · collection patients (exists)
  · bookmark "Today's diary" (exists)
  0 created, 192 skipped
```

That means a permission change arrives as a reviewable diff in a pull request,
which is the entire argument.

## Things worth knowing

Findings from building this that cost time and are not obvious:

- **The `exec` ("Run Script") operation does not run in the `directus/directus:11`
  image.** It reports no error — the flow simply completes with no effect, which
  is miserable to debug. Every flow here uses native operations instead;
  `item-read` supports `aggregate`, which covers most of what a script gets
  reached for. The invoice-total flow sums lines in the database.
- **Directus rejects `.local` and `.example` email addresses.** Its validator
  wants a real TLD, so demo accounts use `example.com` (RFC 2606).
- **The official image runs Directus under PM2 in cluster mode.** Set
  `MESSENGER_STORE=redis` so flow and extension reloads reach every worker.
- **`docker compose down -v` does not remove a bind mount.** The database
  lives in `./data/database`, so the teardown script printed "Gone" over a
  database that was entirely still there and the next setup ran against
  old data while reporting a fresh provision. Two bugs had been hiding
  behind that for months: the migration step aborted on a genuinely empty
  database, and nothing had ever actually proved a clean clone works.
- **Directus redacts `token` on read as a row of asterisks, which is
  truthy.** A seed that trusted it decided the service account already had
  a credential and wrote `**********` into `.env` over the real one. The
  core service kept running — it had the old value in its environment — so
  the only symptom was a 403 from an endpoint nobody had touched. Treat
  `.env` as the source of truth and push it back into Directus.
- **Directus 11 dropped the `exceptions` argument to a hook.** Older guides
  still reach for it, and reading it registers nothing: the hook fails to
  load with a `TypeError` and every rule in it silently stops applying.
  Throw `InvalidPayloadError` from `@directus/errors` instead, as a
  devDependency — the bundler inlines it, and it is not resolvable inside
  the container at runtime.
- **A bundle's entry names share one namespace across types.** A module and
  an endpoint both called `day-sheet` fails the build with "Duplicate
  extension found in bundle", and the endpoint's name is also its route
  prefix — so renaming one moves the URL.
- **BullMQ rejects a custom job id containing `:`.** It uses the colon to
  build its own Redis keys. `reminder:<uuid>` throws; `reminder-<uuid>`
  is fine, and using the appointment id is what makes the sweep safe to
  run on a timer without double-sending.
- **pnpm 11 enforces a minimum release age that pnpm 10 does not.** A
  container doing `corepack enable` gets whatever is newest and can reject
  a lockfile the host just wrote, so the image pins `packageManager`.
- **Postgres will not let you add an exclusion constraint over rows that
  already break it**, and the error names an index rather than the two
  appointments. The provisioning step pre-flights each constraint and
  prints the offending rows instead. Nothing is deleted to make the DDL
  pass — quietly discarding somebody's booking to satisfy a migration is
  how you lose the argument about whether the system can be trusted.
- **JavaScript's `%` keeps the sign of the dividend.** `-3 % 2` is `-1`,
  which put every other past day of the seeded diary an hour early. It
  only showed on days already in the past, because the availability
  trigger does not hold history to today's rota — so a practice that opens
  at eight had a completed seven o'clock appointment on the books.
- **A Directus flow cannot keep a total across a batch.** It keys its update
  on `{{$trigger.payload.invoice}}`, which is one value for one row and an
  array for fifty — so a batch insert writes each total onto the wrong
  record, silently. And on delete it is handed the keys but not the row, so
  it cannot learn which parent to update at all. Both are why invoice
  totals are a database trigger here rather than a flow.

## Integrations

Four places this system touches something outside itself, all behind the
same interface as the messaging channels: hand it a request, get back
either the other side's reference or a refusal that says why and whether
retrying would help.

`GET /api/integrations/adapters` returns what each one actually is. That
endpoint needs no login, because the honest answer to "does this really
take card payments" should not require one.

Which makes every string in it public, and one of them was not fit to be.
The email adapter answered `SMTP to mail:1025` — an unauthenticated
caller learning the mail relay's address, for no reader's benefit. What
an integration **is** is public; where it **points** is the operator's,
and `describe` and `detail` are now two fields rather than one. A check
fails if any public description names a host, a port or a URL, and
another fails if the operator's view stops carrying the part that was
taken out of it, because a split that drops the detail everywhere is a
deletion rather than a fix.

| | | |
|---|---|---|
| `accounting.journal-csv` | **real** | a double-entry journal as CSV — the format every package imports |
| `lab.docket` | **real** | a printable docket, kept as filed |
| `calendar.ics-feed` | **real** | an iCalendar feed any calendar can subscribe to |
| `payments.desk` | **manual** | cash or a standalone terminal, recorded by whoever took it |
| `payments.stripe` | **real** | PaymentIntents, off-session, with the caller's idempotency key — `PAYMENTS_PROVIDER=stripe` |
| `payments.mock-gateway` | **mock** | declines, timeouts and idempotent replays, references prefixed `mock:` |
| `lab.mock-api` | **mock** | dispatch and webhook updates, references prefixed `mock:` |

Stripe is real and is off by default, and it has one caveat worth stating
rather than hiding: a card is collected in a browser by Stripe's own
JavaScript or on a Terminal reader, never by a server, because a server
that handled the number would take on the PCI scope Stripe exists to
avoid. So the adapter charges a PaymentMethod the patient has already
presented, and refuses — clearly, and without retrying — when there is
none. There is no card-collection front end in this repository, which is
why the mock is still the default and still the one the interesting tests
run against.

Three kinds rather than two, because "real or mock" cannot describe the
desk terminal. Nothing there is being simulated — a receptionist took
forty euros in cash, and writing that down *is* the integration. Most
dental practices in the world work exactly that way, and a system that can
only take money through an API is one half of them cannot use.

### Taking money once

The interesting part of a payment integration is not the HTTP call to
Stripe. It is what happens when that call times out: the gateway has not
said whether it took the money, the receptionist sees a spinner and then
an error, and presses the button again.

Two layers answer that, and which one is authoritative matters. The
adapter keeps an idempotency store, which is what a real gateway does —
Stripe holds keys for about a day, on their servers. That is a
convenience and somebody else's promise. **The thing that cannot forget is
the unique index on `payments.idempotency_key`.**

The ordering is the whole design: the row is written **before** the
gateway is called. A row written afterwards is a row that does not exist
when the process dies between the charge and the insert — which is
precisely the moment somebody's card has been debited and the practice has
no record of it. `INSERT … ON CONFLICT DO NOTHING` returning nothing is
not an error, it is the answer, and the second attempt is served from the
row that already holds the key.

Three refusals, deliberately different:

- **A declined card** is `retryable: false`. It is a fact about the
  patient's account and no amount of retrying changes it; a queue that
  tries five times is a slower way of not telling anybody.
- **A gateway that never answered** is `retryable: true` — *and releases
  its key*, because nobody knows whether the money moved and the retry has
  to be allowed to find out. The row stays, marked failed, so the
  ambiguity is visible rather than tidied away.
- **A declined card whose key is tried again** returns the original
  refusal rather than charging. "You already tried this and it was
  refused" is the true answer.

Amounts are integer minor units end to end. `0.1 + 0.2` is
`0.30000000000000004`, and a rounding error in a currency column is found
by a bookkeeper six months later and cannot be explained to them.

A refund is a **negative amount on the same row shape**, not a separate
table — a refund is a movement of money, not a different kind of thing,
and splitting them means every balance is a union. And nobody below the
practice owner can delete a payment: one that turns out to be wrong is
reversed with a negative row, because the money still moved and a deleted
payment is a reconciliation that will never balance again.

### Posting the books once

Idempotence is the only property an accounting export really has to have,
and a date range cannot give it. Posting the same invoice into a ledger
twice produces no obvious error — it produces a set of books wrong by
exactly one invoice, found months later, by which time nobody can say
which run did it.

So rows are **claimed, not selected**. A batch row is created, every
unposted invoice and payment in the period is stamped with it in one
statement, and the journal is built from what the stamp actually caught.
An invoice entered late and dated last week — the exact row a "everything
between these dates" query exports twice — is unposted, so it is picked up
by the next run and by no other. A refused export releases everything it
claimed, or those rows would become invisible to every future run: posted
to a ledger that never received them.

The journal is genuine double entry against four nominals:

```
Invoice raised          Dr 1100 Trade debtors      the whole amount
                        Cr 4000 Fee income         net of tax
                        Cr 2200 VAT control        the part held for the tax authority

Payment received        Dr 1200 Bank
                        Cr 1100 Trade debtors
```

A payment posts to bank and debtors and **must not touch income again** —
income was recognised when the invoice was raised, and recognising it
twice is the classic way to overstate a practice's turnover. The suite
asserts exactly that: no line touching `1200` also touches `4000`.

The adapter refuses an unbalanced journal before anything leaves, because
the alternative is the receiving package rejecting it hours later with an
error nobody in the practice can act on. And CSV fields are quoted when
they need to be — "de Vries, Sofie" is a normal way to write a name, and
an unquoted comma shifts every column after it by one, silently, for that
row only.

### The laboratory

Dispatching twice does not cost money; it costs a second crown. So a case
that already has a dispatch reference is answered from it, and `sent_at`
uses `coalesce` so a re-dispatch never moves the date it originally left —
which is the date an argument with the lab is about.

`lab_cases` has no status column, deliberately: four timestamps are the
state machine, and "has it gone" is `sent_at IS NOT NULL`. A status string
beside those timestamps is a second copy of the same fact, and the two
drift the first time somebody sets one without the other.

The docket carries a **case reference, never the patient's name**. A lab
needs to match returned work to a case; it does not need to know whose
mouth it is, and sending a name and date of birth to a third party because
the form had a box for it is how a practice ends up explaining a
data-sharing agreement it never signed. The suite checks every patient
surname in the database against the generated docket.

It is also **kept as a file**. A lab case is an instruction about a
person's mouth that leaves the building, and when a crown comes back the
wrong shade the argument is about what the sheet said — so the sheet
cannot be quietly edited afterwards into what everybody now wishes it had
said.

The inbound webhook is on **its own secret**, not an operator token: a
laboratory posting a status update has no Directus account and never will,
and reusing the operator credential would hand a third party something
that also reads the diary. An update for a reference nobody recognises
gets a `200` with `matched: false` — the lab did its job, and a 4xx would
make it retry a message that was received perfectly well.

### The calendar, and the line this is really about

An ICS feed is a text file over HTTP, and Google, Outlook and Apple all
subscribe to one. That makes it the only calendar integration worth
building first: it works with *every* calendar rather than one of them,
and needs no OAuth, no refresh tokens and no app review.

The technical details are the ones that separate a feed that works from
one that almost works, and each is a bug somebody has shipped:

- **UID must be stable** for the life of the appointment. A feed that
  generates a fresh UID each poll does not update an event — it adds a
  second one, every time, forever.
- **SEQUENCE must increase** when the event changes, or a subscriber that
  has seen that UID keeps what it has. Derived from `date_updated`, so it
  moves exactly when the appointment does.
- **A cancelled appointment is published as cancelled, not dropped.** A
  subscriber that stops seeing a UID does not remove the event — so
  deleting the row from the feed leaves a ghost appointment in the
  clinician's phone for a patient who is not coming.
- Lines fold at 75 octets, without splitting a multi-byte character. A
  surname with an accent in it is not an edge case.

But the decision worth arguing about is what goes in the SUMMARY line, and
the answer is **not the patient's name, by default**.

A subscribed calendar is not a window onto this system. It is a copy,
synchronised to Google or Microsoft, cached on a phone, readable by
anything with access to that account and searchable by whoever it is
shared with. Putting "Sofie de Vries — root canal 46" in the title exports
a patient's clinical history to a third party by default, every fifteen
minutes, quietly, to whichever calendar the clinician happened to add it
to.

So the default feed says `Patient appointment (Surgery 2)`. That is enough
to run a day from a phone — the clinician needs to know when they are
busy, and the names are in the practice system they are about to walk
into. Naming is available as `?detail=named`, because a single-handed
practitioner who is the only person with access to their own calendar has
a reasonable case, and refusing outright would just produce a spreadsheet
nobody controls. It has to be asked for, and the choice sits in the URL
rather than in a hidden setting, so the person who turned it on can see
that they did.

The suite checks every patient surname in the database against both feeds:
none in the default, several in the named one.

The feed URL is a bearer credential — no calendar client will authenticate
for a text file. What can be controlled is the blast radius, which is why
`directus_users.calendar_token` is a separate column and not a reuse of
the account's API token: that token can write clinical records, and a
calendar URL must never be able to. Rotating it is one `UPDATE`, which is
what revoking a feed somebody pasted into the wrong calendar looks like. A
wrong token is a `404`, not a `403`, because a 403 confirms the token
exists and is simply not yours.

### What building this found in the suite

Three of these checks passed on their first run and failed on their
second, all for the same reason: they read state the run before them had
consumed.

The accounting check exported everything and inspected the journal. That
worked once — and then the next run found only payments left to post, saw
zero income lines, and reported a bug in the exporter that did not exist.
The lab check dispatched an existing case; the second run got the
`alreadySent` path, which correctly returns no docket, and then asserted
that an empty string contained no patient name.

Both now build what they assert on: their own invoice on a date no seeded
row shares, their own payment, their own lab case, and they clean up after
themselves. A check that only passes against a database nobody has touched
is a check that gets deleted the first time somebody touches one.

A fourth was a plain bug in the harness. The helper that calls the core
service parsed every response as JSON — and the calendar feed is
iCalendar, and the 404 beside it is plain text. Both threw, and the helper
reported `status: 0`, which reads as "unreachable". Four checks failed
saying the feed could not be reached while it was answering perfectly
well.

## Backups, and proving they restore

A backup nobody has restored is a hypothesis.

`./scripts/backup.sh` writes an encrypted `pg_dump` and an encrypted
tarball of the file library. Both, because restoring one without the other
gives you a working system full of broken images: the database holds a row
saying "this patient's panoramic is file 8f3a…", and the bytes of 8f3a
live in `./uploads`.

**Encrypt-then-MAC, in that order.** `openssl enc` gives confidentiality
and no integrity at all — flip a byte and it decrypts to garbage, or to
something `pg_restore` half-accepts. A detached HMAC-SHA256 over the
*ciphertext*, keyed with the same passphrase, is checked before anything
is decrypted. PBKDF2 runs at 600,000 iterations rather than openssl's
default 10,000: this is a passphrase, and the only thing between a stolen
archive and every patient in it is what each guess costs an attacker.

### The restore test is the part that matters

`./scripts/restore-test.sh` restores into a scratch database beside the
live one and asserts four kinds of thing. The scratch database is dropped
on the way out, including on failure.

| | |
|---|---|
| The rows | every table, against the live count, not a spot check |
| The records | a named patient, and an md5 over every clinical note — free text is what a broken encoding mangles and nobody notices |
| The rules, by name | four exclusion constraints and four triggers |
| **The rules, working** | it tries a double-booking and an audit-log rewrite against the restored copy, and requires both to be refused |

The fourth is the one worth having. A dump restored without its exclusion
constraints gives you a database that cheerfully accepts a double-booked
chair; one restored without `enamel_access_log_append_only` gives you an
audit log anybody can rewrite. Both look perfect in a row count. And
presence in `pg_trigger` is necessary but not sufficient — `ALTER TABLE …
DISABLE TRIGGER` is a real state a restore can land in, because
`pg_restore` uses it internally while loading data.

One usability point that is really a recovery point: an exported
`BACKUP_PASSPHRASE` overrides the one in `.env`. Sourcing `.env` clobbers
the environment, which is right for every other value and wrong for this
one — the moment you need to override it is the moment you are restoring
an archive written *before* the passphrase was rotated, and discovering
then that the script ignored what you passed is the worst possible time
to find out.

Sixteen checks, and they were made falsifiable the same way everything
else here was — by breaking things on purpose:

- flipping one byte in the archive → the HMAC check fails and nothing is
  decrypted;
- a `--section=data` dump, with the rows but none of the rules → 14 of 16
  fail, naming each missing constraint and trigger.

That second experiment found a bug **in the test itself**. It runs under
`set -o pipefail`, so a `psql` exiting non-zero — which is what "relation
does not exist" is — took the pipeline down and `set -e` killed the script
mid-loop. It printed two passes, stopped, and **exited zero**. A test that
reports success by dying quietly is worse than no test, and the failure it
was hiding is precisely the one it exists to catch. Both query helpers now
end in `|| true` and every check is written to fail on an empty answer
rather than to assume one.

## Continuous integration

`.github/workflows/ci.yml`, three jobs:

- **Types and scripts** — install, build the shared package first (three
  packages import its compiled output, so typechecking before it exists
  reports a missing module rather than a type error), typecheck
  everything, build the extensions and the patient site, and `bash -n`
  every shell script. About a minute, and it catches most mistakes.

  *Everything* is asserted rather than assumed. `pnpm -r typecheck` runs
  whatever each package declares, and for a long time seven of the twelve
  declared nothing — six of those had a `tsconfig.json` no command ever
  used. That is how a renamed ref survived a build and shipped: a bundler
  resolves modules, not identifiers, and nothing else opened the file. The
  extensions type-check through `vue-tsc`, which reads the `<script
  setup>` block as TypeScript, and a check in the suite fails if a
  workspace package stops declaring the script.
- **The access model, against a real stack** — brings up Postgres, Redis,
  Directus, the core service and the patient site, provisions from
  nothing, seeds, and runs the whole suite. Not a mock of the stack: a
  permission model you have not tried to break is a hope, and you cannot
  try to break one that isn't running.
- **A backup that restores** — takes a backup and runs the restore test,
  in an environment that has never seen either work. Then greps the first
  256 KB of the archive for `PGDMP` and for patient data, because "it
  looked like binary" is how an unencrypted backup gets shipped.

CI runs `directus/directus:11`. 12.x refuses custom rules on access
policies unless licensed, those rules are the entire subject of the suite,
and a licence key is a secret CI does not get. It is the one place this
project's README and its CI deliberately differ, and it is written down in
both.

## Rate limiting, and a bug server rendering caused

Turning the limiter on broke provisioning, twice, and both breaks were
worth having.

The bootstrap fires several hundred sequential calls from one address. It
tripped the per-IP limit halfway through the flows and the whole run died
on `429 Too many requests, retry after 211ms` — a server that had just
said, in those words, exactly what to do about it. The fix is the client,
not the limit: raising the limit until provisioning fits under it would
mean choosing a production rate limit to suit a script that runs twice a
day. Every JSON call now reads `Retry-After`, waits, and retries; only a
429 is retried, because a 403 is an answer and retrying an answer is how a
suite starts passing for the wrong reason.

Then it broke again in the one place that was exempt. Multipart uploads
cannot go through the JSON client, so they used a bare `fetch` — and the
branding step pushes ten images in a row and died on the ninth. Two call
sites needing the same retry is one call site; both now go through
`postFile`.

The verify suite has the same problem and a sharper version of it: it
deliberately bursts Directus to prove the limiter works, so any check
landing in the following second would fail with a 429 and report a
permission problem that does not exist. A harness that cannot tell
"refused because you may not" from "refused because you were quick"
reports noise. `fetch` is shadowed for that module — and the burst itself
pointedly uses the unwrapped one, or it would succeed on the second
attempt and conclude there was no limiter at all.

Both services count in **Redis, not in memory**, and the store is the part
worth explaining. The official Directus image runs under PM2 in cluster
mode, so there is more than one worker; the core service can be run as
more than one container. An in-memory counter gives each its own budget,
so the effective limit is "the number you configured × however many
processes happen to be running" — and the number in the config file
quietly stops describing the system.

The interesting part is what building the patient site did to this.

The site is server-rendered. Every request it makes to the practice leaves
from **its own container**, so to anything counting per IP downstream, the
entire patient population is one caller. The registration limiter is per
IP. One bucket for everybody is not a limiter, it is a queue with a cap —
the twenty-first person to sign up in an hour was refused because of the
twenty before them.

So the site forwards the real client address — `CF-Connecting-IP` in
production, because the edge writes it and a client cannot — and the core
service resolves it with Express's `trust proxy`. Set to a **list**, never
to `true`. `trust proxy: true` means "believe whatever anybody claims
about their own address", which turns every per-IP control in the service
into decoration: an attacker sets a new header per request and each one is
a fresh bucket. The default is the private ranges, which is where the
compose network lives; a deployment narrows it to the load balancer's
address.

The suite asserts the consequence rather than the setting: two forwarded
addresses get independent budgets and the same one decrements. If the
resolution breaks, those two numbers become identical and the check fails.

Two more decisions worth naming:

- **`/health` is excluded.** The orchestrator polls it several times a
  minute forever. Counting that against real traffic means a busy minute
  makes the service look unhealthy and gets it restarted — a limiter
  causing the outage it was meant to prevent.
- **Redis being down does not refuse the request.** A limiter that fails
  closed turns a cache outage into an outage of the practice's diary,
  which is a worse day than the one it was protecting against.

A note on what is *not* solved by this. In this compose file the core
service's port is published on the host so the suite can reach it, and the
host sits on a private range — so locally, anything that can reach the
port can claim any address. That is a demo convenience, and in a
deployment the service is not published at all: the only thing that can
reach it is the balancer, and the trusted list is that balancer's address.

## What is documented rather than built

Everything above runs. Everything below is the honest version of the
question "what would this need in production", written out rather than
implied by a diagram — because the interesting part is the numbers and the
trade-offs, not the names of the tools.

### Point-in-time recovery

The nightly dump is the wrong granularity for a clinical system. A
practice that loses the day loses appointments people turned up for and
notes written after treatment; an RPO of 24 hours is not a recovery
strategy, it is an apology.

PITR is `archive_mode = on` with an `archive_command` pushing WAL
segments to object storage, a weekly `pg_basebackup`, and recovery by
`restore_command` plus `recovery_target_time`. The RPO is then
`archive_timeout` — 60 seconds is a reasonable setting here, because a
dental practice's write volume is low enough that a minute of WAL is a
handful of segments and large enough that a shorter timeout mostly ships
empty ones.

The dumps stay, and are not redundant with this. WAL replay reconstructs
the database as it was, including whatever mistake you are recovering
from; a dump is what you compare against when the question is "what did
this record say before somebody changed it". They answer different
questions.

### Replication

A streaming replica with `hot_standby = on`, and **asynchronous**
commit — which is the trade worth stating rather than defaulting into.
Synchronous commit costs a network round trip on every write and means a
replica outage stalls the practice; asynchronous risks losing the last
few transactions in a failover. For a dental practice the write volume is
low and the failure mode is recoverable by asking the receptionist to
retype the last thing she typed. Synchronous replication would be the
right answer for the billing ledger of a bank; it is the wrong answer
here, and picking it anyway is how an application gets slow for reasons
nobody can later explain.

The replica is also where reporting should read from. `/api/reports/summary`
aggregates across the whole diary, and a query that scans a year of
appointments is a query that should not be competing with a receptionist
trying to book one.

### Disaster recovery

The numbers, because "we have backups" is not a target:

| | |
|---|---|
| RPO | 60 seconds with WAL archiving; 24 hours with dumps alone |
| RTO | dominated by restoring the file library, not the database — the dump is megabytes and the radiographs are not |
| Tested | the restore test, run by CI on every change and on a weekly schedule |

The RTO line is the one people get wrong. A dental practice's database is
small and its images are not: restoring 40 GB of radiographs from object
storage is the long pole, and the mitigation is that the file library
should not be a bind mount in production. It should be object storage
Directus reads through, so a recovery restores a database that already
points at files which never went anywhere. Directus supports S3-compatible
storage natively — this repo uses a local directory because a demo should
not require a bucket.

### A WAF, and what it is actually for here

Two endpoints justify one, and they are the two that face the internet
without a token: `POST /auth/login` and the registration endpoint.

Credential stuffing against the first is the realistic attack — patients
reuse passwords — and the defence that works is not a WAF rule but a
breached-password check at registration and a lockout with backoff.
What the edge adds is bot scoring and the ability to refuse traffic
*before* it costs a database connection.

And the edge is the only layer that sees the real client address before
the request costs anything. Per-patient rate limiting genuinely belongs
there rather than in the application; the limiters in this repo are a
backstop for a deployment that has no edge, which is why they are written
as "enough to stop a script" and not presented as more.

### Monitoring

Four signals, chosen because they are the ones that fail *silently* in
this particular system. Uptime and error rate are table stakes and every
tool does them; these are the ones a generic dashboard would not think to
watch.

1. **The queue's failed set.** Already exposed at
   `/api/messaging/status`. The whole reason the reminder flow was moved
   out of Directus is that a flow could not fail visibly — "have the
   reminders gone out" was a question nobody could answer. A non-zero
   failed count that nobody is alerted on recreates exactly that.
2. **The audit log going quiet.** `access_log` should gain rows all day.
   If the hook fails to register — which it once did, silently, because
   Directus 11 dropped the `exceptions` context argument — the log goes
   quiet and everything else looks completely normal. "No new rows in an
   hour during opening hours" is the alert that catches it.
3. **Backup age, and last successful restore.** Two separate metrics on
   purpose. A backup taken last night and a backup that restored last
   night are different facts, and only the second one is worth anything.
4. **Replication lag**, once there is a replica — because an
   asynchronous replica that has silently stopped replaying is a hot
   standby that will fail over to last week.

## Scope, honestly

This is a reference build, not a product. It models patients, scheduling,
clinical records, charting and invoicing well, and deliberately stops there — no
inventory, payroll or insurance claims. Depth in the access model is
the point; breadth of features is not.

Scheduling is the part that goes deepest, because it is the part of a
dental product that is hardest to get right: conflicts, availability,
rotas, leave, chair downtime, and a view a receptionist will actually use.
What is still missing there, said plainly — recurring appointments,
multi-appointment courses of treatment booked as a block, room-and-clinician
preferences beyond a usual chair, and any notion of a waiting-list
auto-fill when a cancellation frees a slot. The waiting list exists and is
read by a human.

Imaging stops at a boundary rather than trailing off. A DICOM study's
header is read and its pixels are not, for the reasons set out above —
codecs, windowing, volumes and a calibrated display are a PACS, and half
a PACS is worse than none because it still looks like it works.

The patient site does what a portal is for and no more: register, see your
own record, book, cancel. It does not take payment — it shows what is
outstanding and says the practice takes the money — and it cannot claim an
existing patient record, which needs an invitation the practice sends to
an address already on file rather than a stranger matching on a birthday.

**All data is invented, including the images.** The radiographs are drawn
by `scripts/make-demo-radiographs.mjs` — signed-distance shapes, blurred,
with film grain — and are labelled as synthetic on the records
themselves. No real patient imaging appears anywhere in this repository
and none should: a radiograph is identifiable health data under GDPR
Article 9, and "we found it on the internet" is not a lawful basis.

**Never point this at real patients.** Nothing here claims
HIPAA or GDPR compliance — it demonstrates the access-control patterns clinical
data requires, which is a necessary part of compliance and nowhere near all of it.

Two documents make that claim checkable rather than asking you to take it:

- **[docs/COMPLIANCE.md](COMPLIANCE.md)** maps each control that
  exists to the obligation it serves — GDPR Articles 15, 17, 25, 30, 32,
  33/34, NEN 7513, MDR — with a file path against every row, and an
  honest list of what is missing.
- **[docs/DPIA.md](DPIA.md)** is the Article 35 assessment, organised
  around 35(7)'s four required parts. Its §3.3 records a risk that was
  **realised** during development and fixed, and its §4.7 lists the
  measures *not* taken with the consequence of each — because an
  assessment containing only what was done is a list of features.

Neither has been reviewed by a DPO or a lawyer, and both say so.

