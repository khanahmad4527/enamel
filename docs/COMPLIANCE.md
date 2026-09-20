# Compliance, mapped

Most of the controls in this repository were built because they are the
right way to hold clinical data, not because a regulation was open on the
desk. This file does the mapping afterwards: for each control that
already exists, the obligation it serves.

**What this is not.** It is not a certification, an audit, or legal
advice. It is an engineer's account of which requirement each piece of
code was aiming at, written so that somebody qualified can check the aim.
Every row points at code you can read.

The Article 35 assessment is a separate document —
**[DPIA.md](DPIA.md)** — because a DPIA is an argument about risk rather
than a map of controls, and mixing the two produces neither.

The centre of gravity is European, because the demo practices are in
Amsterdam and Dubai and because the strictest applicable regime is the
right one to design against.

---

## The regulations this is built against

| | |
|---|---|
| **GDPR** (EU 2016/679) | Health data is **Article 9** special category, so the bar is higher than ordinary personal data throughout |
| **NEN 7510 / 7512 / 7513** | Dutch healthcare information security. **7513 is specifically about logging access to electronic patient records** |
| **ISO 27001**, **ISO 27799** | Information security management, and its health-sector companion |
| **MDR** (EU 2017/745) | Medical devices. **Annex VIII Rule 11** is the one that decides what this software may render — see below |
| **EHDS** (EU 2025/327) | European Health Data Space. Nothing is built against it yet; named because it is the direction of travel |
| **WGBO** (NL), **UAE Federal Law 2/2019** | Statutory retention of medical records — and they disagree, which is why retention is data here and not a constant |

---

## Article 25 — data protection by design and by default

This is the article the whole project is an argument for, and the
"by default" half is where most of the interesting decisions are.

| Control | Where | The default it sets |
|---|---|---|
| Calendar feed omits patient names | `apps/core/src/integrations/calendar/calendar.service.ts` | A subscribed calendar is a **copy** synchronised to Google or Microsoft. The default feed says `Patient appointment (Surgery 2)`. Naming is `?detail=named`, has to be asked for, and sits in the URL where the person who enabled it can see that they did |
| Lab docket carries a case reference, never a name | `apps/core/src/integrations/lab/docket.adapter.ts` | A laboratory needs to match returned work to a case. It does not need to know whose mouth it is |
| Registration cannot confirm whether an address is known | `apps/core/src/portal/portal.service.ts` | A duplicate returns the **success shape**. "That address is already registered" is a lookup service for anybody who can guess an email |
| Consent defaults to email only | `patientConsentFields`, `schema/messaging.ts` | Holding a mobile number is not consent to text it |
| The patient site holds no credential | `apps/public/app/lib/api.server.ts` | Every call carries the patient's own token, so the site is *incapable* of reading another patient's record — including by bug |
| Front-desk policy names the fields it may see | `access/policies.ts`, `FRONT_DESK_PATIENT_FIELDS` | `medical_alerts`, `allergies` and `clinical_notes` are **absent** rather than denied. Least privilege by field, not by collection |

## Article 32 — security of processing

| Control | Where |
|---|---|
| Access control enforced at the API, not in application code | `access/policies.ts` — what each role may read is a field list and a row filter on the policy, not a branch in a controller |
| The clinical rules hold below the application too | `EXCLUDE USING gist` constraints and triggers in `constraints.ts` — a double booking is refused by Postgres, so no client can route around it |
| Tokens never reach browser JavaScript | `apps/public/app/lib/session.server.ts` — httpOnly signed cookie, every call in a loader or action |
| Backups encrypted, integrity-checked before decryption | `scripts/backup.sh` — AES-256-CBC, PBKDF2 at 600,000 iterations, detached HMAC over the ciphertext |
| Restores are **tested**, not assumed | `scripts/restore-test.sh` — restores into a scratch database and then *tries a double-booking* against it, because a trigger can restore and still be disabled |
| Rate limiting, counted in Redis | `apps/core/src/limits/rate-limit.middleware.ts` and the Directus `RATE_LIMITER_*` settings |
| Separate credential per integration | The reminder sweep, the portal registrar and the inbound webhook each hold their own, so one leak is not all of them |

## Article 30 — records of processing, and Article 33/34 — breach notification

Both depend on being able to answer *who touched whose data*, and that is
`access_log`.

**The distinction worth stating plainly**, because it looks like
duplication and is not:

| | `directus_activity` | `access_log` |
|---|---|---|
| Writes | yes | no — deliberately not duplicated |
| Logins | yes | and failed ones, with the attempted address |
| **Reads — who opened whose record** | **never** | **yes; this is the point** |
| Append-only | no, an admin can delete rows | yes — `enamel_access_log_append_only` |
| Reads made by the core service straight from Postgres | invisible | recorded |

Directus records **zero read events**. That was verified, not assumed. For
a clinical system the question that matters most is *"who opened this
patient's file"*, which is exactly what **NEN 7513** requires logging and
what a 72-hour breach assessment needs in order to say whose data was in
the blast radius.

The second difference is immutability. `directus_activity` is an ordinary
collection an administrator can delete from; `access_log` has a trigger
behind it, so the log survives the person being investigated.

## Article 17 — erasure, and its limits

A clinical record has a statutory retention period that **overrides**
erasure. A system that deletes everything on request is as wrong as one
that refuses everything.

- Retention is modelled as data — see `retention_rules` — because NL and
  the UAE disagree about it and a constant in the code would be wrong for
  one of them.
- The audit log had to be taught not to block erasure. `access_log`'s
  foreign keys are `ON DELETE SET NULL`, a SET NULL cascade is an
  **UPDATE**, and the append-only trigger refused every update — so any
  patient who had ever been *read* could not be deleted. The trigger now
  allows a key to go set→NULL and nothing else. The row outlives the
  patient; the pointer does not.

## Article 15 — right of access

Two obligations, and most implementations meet one.

**15(3), the copy.** `GET /api/subject-access/:patient` answers with every
part of the record — 27 sections, from the chart and the clinical notes to
the invoices, the messages and the log of who looked. The list of sections
is written down in one file next to a sentence describing each part in
words a patient can read, because the failure mode of a subject access
response is not a bug: it is somebody exporting the six tables they
remembered and the seventh turning up later.

**15(1), the information that goes with it.** The copy is accompanied by
why the data is held, the legal basis (Art. 9(2)(h) for the clinical
record, and why consent deliberately is not it), who else sees it, where
it came from, what the patient can ask for next — and two things that are
usually missing:

- **the actual retention period**, read from `retention_rules`, because
  15(1)(d) asks for the envisaged period and not for "as long as
  necessary";
- **that nothing is decided automatically**, which 15(1)(h) asks about and
  which is only worth stating because it is true here.

### It runs as the person who asked for it

No service credential. Every read carries the caller's own Directus token,
which has two consequences and both are the design:

- the endpoint cannot become a way around the permission model — a feature
  that assembles a document from tables the caller may not read is a
  privilege escalation wearing a compliance label, and it is the shape a
  subject access export naturally wants to take;
- a caller who cannot read every part gets a **refusal naming the parts**,
  not a document that is quietly incomplete. Reception is told it cannot
  read the clinical notes or the consents. Handing a patient an export
  with silent holes in it is worse than refusing.

Running it that way answered a question rather than confirming one. The
person who can produce a complete response is the **practice owner** — a
clinician is refused too, because payments and the access log are not
theirs. That fell out of the design; it was not decided in advance.

**The export is itself a read of the whole record, so it writes its own
`export` row to the access log** before the bytes leave. It would
otherwise be the one read in the system that left no trace, and it is the
single event a practice most wants to be able to find afterwards.

The patient portal still shows a patient their own appointments, invoices,
payments, letters and consent forms, which is the everyday half of the
same right.

## Article 35 — data protection impact assessment

Written: **[docs/DPIA.md](DPIA.md)**.

Article 35(3)(b) names processing on a large scale of the Article 9
special categories outright, and a dental record is health data, so the
question was never whether one was required.

It is organised around 35(7)'s four required parts rather than around the
software — the processing and its purposes, necessity and
proportionality, the risks to rights and freedoms, and the measures. Three
things in it are worth reading before the rest:

- **§2 is about where the system takes less than it could**, which is the
  proportionality question. "Is this necessary" answered yes is not an
  assessment.
- **§3.3 records a risk that was realised**, found and fixed during
  development — a patient could book an appointment onto another
  patient's record. A DPIA that lists no realised risks is a DPIA nobody
  tested.
- **§4.7 lists the measures NOT taken**, with the consequence of each. A
  measures section containing only what was done is a list of features.

It has not been reviewed by a DPO or a lawyer, and §6 says what a reviewer
should push back on first.

## MDR (EU 2017/745) — why the viewer disclaims

Not "arguably". **Regulation (EU) 2017/745, Annex VIII, Rule 11**:
software intended to provide information used to take decisions with a
diagnostic or therapeutic purpose is **Class IIa**, rising to IIb where a
wrong decision could cause serious deterioration and III where it could
cause death. Diagnostic imaging software lands in that rule.

Class IIa is not a label. It is a notified body, a clinical evaluation
under Annex XIV, technical documentation under Annex II, a quality
management system to ISO 13485, post-market surveillance and vigilance
reporting. Years and a budget.

The other side of the line is drawn by **MDCG 2019-11**: software that
stores, archives, communicates or performs simple search is not a device.
That is where this system sits, and it sits there on purpose.

**The classification follows the intended purpose, not the feature list.**
A practice management system that rendered a radiograph *for reading*
would be claiming a purpose it has not been assessed for — which is why
the refusal panel says so in the interface rather than only in a file
somebody has to go and find.

So the radiograph viewer:

- adjusts brightness, contrast and inversion **on the way to the screen
  only** — the stored file is never re-encoded, and when anything is
  adjusted the image is captioned *"Adjusted for viewing — the stored
  image is unchanged"*;
- states that it is for review on this screen and that diagnosis needs a
  calibrated display;
- **refuses to render DICOM pixel data at all**, and says why.

That disclaimer is not politeness. It is the line between storage and a
Class IIa device, and it is why decoding DICOM here is out of scope
rather than merely difficult.

The route out is the same one a practice would take anyway: **DICOMweb** —
WADO-RS to fetch, STOW-RS to store, QIDO-RS to search — handing the study
to a viewer that *has* been assessed. An adapter boundary rather than a
half-written decoder.

## Articles 33 and 34 — the breach register

The half that gets missed is not the reporting. It is **Article 33(5)**:

> The controller shall document **any** personal data breaches, comprising
> the facts relating to the personal data breach, its effects and the
> remedial action taken.

*Any.* Including the ones a practice decides not to report, which is most
of them — and for those the register has to show the **reasoning**,
because that is what a supervisory authority asks to see. A register
containing only the reported ones is evidence that the reporting decision
was never written down.

So `data_breaches` is seeded with two entries per practice, and the second
is the one worth having: a reminder sent to one wrong address, assessed as
unlikely to result in a risk, **not** notified, with the assessment
recorded. The database refuses the row without it.

### The clock

Three things about the 72 hours are wrong in most implementations:

- It runs from **awareness**, not from when the breach happened. A laptop
  taken in March and noticed in June starts the clock in June — so
  `discovered_at` is required and `occurred_at` is optional, which is the
  opposite of how it is usually modelled.
- It is **72 hours**, not three working days. A Friday afternoon
  discovery is due on Monday afternoon.
- **Late is allowed and is not free.** Article 33(1) requires a late
  notification to be "accompanied by reasons for the delay", so a row
  notified after its deadline with no reason is refused.

`notify_by` is computed by a database trigger, never by the form. A
deadline that depends on whoever typed it is not a deadline.

### Two duties, two thresholds

`risk` has three values rather than being a boolean, because Article 33
(tell the authority) and Article 34 (tell the people) have different
thresholds. Collapsing them is how a practice tells a regulator and not
the patients — so a **high-risk breach cannot be closed** until
`subjects_notified_at` is filled in.

### The register is not tidyable

No delete permission, for anybody, including the practice owner. The row
that most wants deleting is the one an authority most wants to read, and
"we removed it because it turned out to be nothing" is the sentence that
ends badly. Closing a breach is a status, not a deletion.

Every rule is enforced twice: a hook, which produces a sentence a practice
manager can act on, and a Postgres trigger, which is the one that cannot
be routed around. The suite asserts the second by writing straight to
Postgres with Directus out of the picture.

## Disposal — the third of records management

ISO 15489 separates three things that systems routinely collapse into one
cron job:

| | Where |
|---|---|
| the **schedule** — how long each kind of record is kept | `retention_rules` |
| the **review** — what has passed its period | `GET /api/retention/due` |
| the **authorisation** — a person deciding these particular records may go | `disposals` |

"Delete anything older than N years" is wrong twice over. A period is a
**minimum to keep**, not a deadline to destroy — a record under a
complaint, a claim or a safeguarding matter is kept past its period
*because* the period elapsed and somebody looked. And an automatic
destruction is both irreversible and unattributable: nobody decided, so
nobody can be asked.

So `disposals` records the decision, not the deletion. Four rules, each
enforced by a hook for the sentence and a trigger for the guarantee:

- an authorised disposal needs a **name, a date and the grounds** — one
  authorised by "the practice manager" is authorised by nobody;
- a carried-out one has to say what actually happened (deleted,
  anonymised, transferred, shredded) and when;
- **it cannot have been carried out before it was authorised**, which is
  the rule the collection exists for;
- and holding a record back has to say **why** — without somewhere to
  record that, "not this one" can only be expressed by doing nothing,
  which is indistinguishable from not having looked.

No delete permission, for anybody. A register the signatory can remove is
not evidence.

**Nothing in this system destroys a clinical record.** A deployment that
wants the destruction to follow can hang it off an authorised row; the
ordering is the point.

## Retention — and why it is data

| Jurisdiction | Adult clinical record | Basis |
|---|---|---|
| Netherlands | **20 years** from the end of treatment | WGBO, Art. 7:454 BW |
| United Arab Emirates | **25 years** | Federal Law No. 2 of 2019 on ICT in Health Fields |
| Germany | 10 years | §630f BGB |
| United Kingdom | 11 years for adults; children until age 25 | NHS Records Management Code of Practice |

The demo practice is in Amsterdam, so the Dutch period applies — but the
table above is the reason `retention_rules` is a table at all rather than a
constant in the code. The same software installed in Dubai or Dusseldorf is
subject to a different statutory period, and a number compiled into the
source is a number that is wrong somewhere. The rules are data, keyed by
record type, and the site reads them.

Nothing deletes anything automatically. The rules record what the
obligation *is*; acting on them is a decision with a human in it.

---

## Honest gaps

- The DPIA (`docs/DPIA.md`) has not been reviewed by a DPO or a lawyer,
  which Article 35(2) expects where one is designated.
- The subject access export is produced by the practice, not requested by
  the patient in the portal. A patient still has to ask.
- Consent to *processing* is not modelled; the consent here is per
  communication channel, which is a different thing.
- Nothing destroys a clinical record. The schedule, the review and the
  authorisation all exist; the act does not, and a deployment that wants
  it has to build it against an authorised row.
- WCAG 2.2 AA is the stated target for the patient site. Contrast ratios
  are computed, axe reports no violations across thirteen pages, and the
  accessibility *tree* is asserted — the error summary takes focus, the
  slot picker is a real radio group announced as words. **No pass with an
  actual screen reader has been done**, and that is a different thing: a
  clean tree is a necessary condition for usable, not a sufficient one.
- Nothing here has been reviewed by a DPO or a lawyer.
