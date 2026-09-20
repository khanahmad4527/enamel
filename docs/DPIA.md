# Data protection impact assessment

**Enamel — dental practice management**
Version 1 · 14 September 2026 · status: **draft, unreviewed**

---

## What this document is, and what it is not

Article 35 requires a DPIA "where a type of processing is likely to result
in a high risk to the rights and freedoms of natural persons", and
35(3)(b) names one of the cases outright: processing on a large scale of
the special categories in Article 9. A dental record is health data. A
practice management system holding several thousand of them is inside that
description.

Article 35(7) sets out what a DPIA must contain, and this document is
organised around those four headings rather than around the software:

1. a systematic description of the processing and its purposes;
2. an assessment of necessity and proportionality;
3. an assessment of the risks to the rights and freedoms of data subjects;
4. the measures envisaged to address those risks.

**It has not been reviewed by a data protection officer or a lawyer.** It
is the assessment the people who built the system can honestly make, and
Article 35(2) requires a controller to seek the DPO's advice where one is
designated. Section 6 lists what a reviewer should push back on first.

A deployment is a **different** processing operation from this repository:
different scale, different jurisdiction, different sub-processors, its own
retention decisions. This is a starting point for that assessment, not a
substitute for it.

---

## 1. A systematic description of the processing

### 1.1 Who does what

| | |
|---|---|
| **Controller** | Each dental practice, separately. A practice decides what is recorded about its own patients and why |
| **Processor** | Whoever operates the installation on the practices' behalf |
| **Joint control** | None. One installation serves one practice, which decides alone what is recorded about its patients and why |
| **Sub-processors** | Whatever a deployment configures: an SMTP relay, an SMS provider, a card gateway, a dental laboratory. All are off by default and named in configuration (see §4.6) |

### 1.2 Whose data, and what

| Category | What | Article 9? |
|---|---|---|
| Patients | Name, date of birth, address, telephone, email, language | No |
| Patients | Dental record: findings, treatment, notes, charts, periodontal measurements, medical history, allergies and alerts | **Yes** |
| Patients | Radiographs and photographs | **Yes** |
| Patients | Consent forms, treatment plans | **Yes** |
| Patients | Invoices, payments, payment plans | No |
| Patients | Messages sent and replies received | Mixed — an appointment reminder implies attendance at a dental practice |
| Staff | Name, email, job title, working pattern, absences | Absence *reasons* can imply health; see §3.6 |
| Everyone | Access log: who opened which record, when, from where | No, but it is a record *about* staff |

### 1.3 Why

- **Providing dental care.** Article 9(2)(h) — medical diagnosis and
  treatment by a professional bound by confidentiality — read with
  Article 6(1)(c) and the national law that requires the record to exist.
- **The contract between patient and practice.** Article 6(1)(b): the
  appointment, the invoice, the messages about them.
- **Legal obligations the practice cannot decline.** Article 6(1)(c):
  statutory retention (20 years in the Netherlands, 25 in the UAE), and in
  the Netherlands the logging obligation under NEN 7513.

Consent (Article 6(1)(a)) is **deliberately not** the basis for the
clinical record. Care that stops if a patient withdraws consent to being
recorded is not care, and a basis nobody can actually withdraw is not
consent. It is used where it genuinely applies: whether the practice may
text rather than email.

### 1.4 Where it goes

```
patient's browser ──▶ patient site (server-rendered, holds no credential)
                          │  the patient's own token, in an httpOnly cookie
                          ▼
staff browser ─────▶ Directus  ◀────── core service (slot search, delivery)
                          │                    │
                          ▼                    ▼
                     PostgreSQL          SMTP / SMS / gateway / laboratory
                                         (all off by default)
```

Nothing leaves the installation unless a deployment turns on a provider,
and naming one without its credentials stops the service rather than
falling back to a mock.

### 1.5 How long

Per practice, per record type, in `retention_rules` with the statute cited
— because the two demonstration practices are subject to genuinely
different periods and no constant is right for both. Nothing expires
automatically; §4.5 explains why that is the assessment rather than an
omission.

---

## 2. Necessity and proportionality

Article 35(7)(b) asks whether the processing is necessary *and*
proportionate to the purpose. The interesting answer is not "yes"; it is
where the system takes **less** than it could.

| Decision | The proportionate answer | Where |
|---|---|---|
| Reception's view of a patient | Named fields, not a denied list. `medical_alerts`, `allergies` and `clinical_notes` are **absent** from the front-desk policy | `access/policies.ts` |
| Calendar feed | `Patient appointment (Surgery 2)` by default. A subscribed feed is a copy synchronised to Google or Microsoft; naming has to be asked for and the request is visible in the URL | `integrations/calendar` |
| Laboratory docket | A case reference. A laboratory matches returned work; it does not need to know whose mouth it is | `integrations/lab` |
| Reminder content | Practice, date, time. Never the treatment — "your root canal on Tuesday" is a disclosure to whoever picks up the phone | `messaging` |
| Registration | A duplicate address returns the **success shape**. "That address is already registered" is a lookup service for anybody who can guess an email | `portal/portal.service.ts` |
| Messaging consent | Email on, SMS and WhatsApp off. Holding a mobile number is not consent to text it | `schema/messaging.ts` |
| Public website | A separate read-only credential that can reach five collections and is refused on nine | `access/policies.ts`, `websiteVisitor` |
| Radiograph viewer | Refuses to render DICOM at all. Rendering *for diagnosis* would make this a Class IIa medical device under MDR Annex VIII Rule 11 | `imaging/dicom.ts` |

**Where the system takes more than the minimum, and why.** The access log
records every read of patient-identifiable data — who, when, which
collection, which patient, IP and user agent. That is a substantial body
of data about **staff**, and it is processed because NEN 7513 requires it
and because it is the only way to tell a proper clinical interest from a
nosy one. It is proportionate on that basis and would not be on any other:
it is not used for performance management, and §4.7 records the control
that has not been built.

---

## 3. Risks to the rights and freedoms of data subjects

Assessed as *likelihood × severity* for the data subject — not for the
practice. A risk is scored high where the consequence is to a person's
health, dignity or safety, regardless of what it costs the business.

### 3.1 One practice reads another's patients

**Severity: high. Likelihood: low.**
A clinical system's defining failure. What each role may read is a field
list and a row filter on their policy rather than a branch in application
code; the core service acts as the caller rather than as itself on every
write; and the constraints in `constraints.ts` sit below the application
where no client can route around them. The verify suite asserts the boundary
from the
outside, as each role.

**Residual:** the core service reads Postgres directly for slot search and
retention, bypassing Directus permissions entirely. Two features, each
carrying its own clinic filter by hand. That is two places a future
feature could forget, and the mitigation is that both are asserted.

### 3.2 A member of staff reads a record they have no business in

**Severity: high. Likelihood: medium.**
The classic health-records harm: a neighbour, an ex-partner, somebody
famous. Least privilege by field limits what most roles can reach at all,
and the access log makes a legitimate look distinguishable from a nosy
one after the fact.

**Residual: nothing alerts.** The log answers the question when somebody
asks it. Nobody asks it on a Tuesday. See §4.7.

### 3.3 A patient reads another patient's record

**Severity: high. Likelihood: low.**
The patient site holds **no credential**: every call carries the patient's
own token, so the site is incapable of reading another patient's record
even if its code is wrong.

**This risk was realised during development.** A patient could create an
appointment on another patient's record — Directus ignores `permissions`
on a create, and the rule is relational so it cannot live in `validation`
either. Found because a check that had been passing for the wrong reason
finally told the truth. Fixed in the scheduling hook. It is recorded here
rather than quietly repaired because a DPIA that lists no realised risks
is a DPIA nobody tested.

### 3.4 Clinical images reach somebody who should not see them

**Severity: high. Likelihood: low.**
`/assets/<uuid>` answers on `directus_files` alone, so hiding a document
row hides the metadata and not the bytes. A marker on the file itself
carries the clinical classification, because a relational
filter inside a permission is evaluated with the caller's own visibility —
"no radiograph points at this file" is true for reception about every file
in the building.

### 3.5 A message reaches the wrong person

**Severity: medium. Likelihood: medium.**
The commonest real breach in a practice, and the one in the seeded
register. Content is minimal by design (§2), which caps the severity: a
misdirected reminder discloses a first name and an appointment time.
Numbers without a country code are refused before they are sent rather
than accepted and silently dropped.

**Residual:** nothing validates that an address belongs to the patient it
is filed under. A transposed character is undetectable at entry.

### 3.6 Staff data used for something it was not collected for

**Severity: medium. Likelihood: medium.**
Absence *reasons* can imply health data about an employee, so the
front-desk policy reads absences **without** the reason field. The access
log is a detailed record of staff activity and is exactly what
performance management reaches for.

**Residual:** no technical control stops that use. It is a policy
question, and this document is where the position is stated rather than
assumed.

### 3.7 A patient cannot get their own data, or gets somebody else's

**Severity: medium. Likelihood: low.**
The subject access export runs **as the caller** — no service credential —
so it cannot become a way around the permission model, and a caller who
cannot read every part gets a refusal naming the parts rather than a
document with silent holes in it. Every row in an export carries the
subject's own id, which the suite asserts.

### 3.8 Data kept longer, or shorter, than the law requires

**Severity: medium (both directions). Likelihood: medium.**
Destroying a record still required is as serious as keeping one too long —
it removes a patient's evidence about their own treatment. The clock runs
from the patient's last contact, not from the row's own date; getting that
backwards destroys records that are still required, and the suite asserts
it with a twenty-five-year-old note on a patient who still attends.

### 3.9 The practice cannot tell what happened after an incident

**Severity: high. Likelihood: low.**
An append-only trigger makes the access log unrewritable by anybody,
including an administrator and including a direct database connection.
Backups are encrypted and integrity-checked, and the restore is *tested*
rather than assumed.

### 3.10 A misconfiguration silently stops a control working

**Severity: medium. Likelihood: medium — and this is the honest one.**
Every realised problem in this project has been of this shape: something
that looked right, reported success and did nothing. A permission ignored
on create. A check passing for the wrong reason. A collection whose meta
was never reconciled. A provider that would have fallen back to a mock
while the practice believed it was texting patients.

The mitigation is structural rather than a control: **a half-configured
provider stops the service**, the suite asserts behaviour from outside as
each role, and every claim in it has been broken on purpose to confirm it
fails. It is a mitigation with a known ceiling, which is the point of
writing it down.

---

## 4. Measures

### 4.1 Access control

Enforced at the API by policy, not in application code; the field lists
name what a role may see rather than denying what it may not. Asserted
from outside, as each role, on every run.

### 4.2 Below the application

`EXCLUDE USING gist` constraints, row-level triggers and an append-only
audit guard. A rule in the database is a rule a future endpoint, a flow
and a direct connection all meet.

### 4.3 Credentials

One per integration, each narrowly scoped: the reminder sweep reads the
diary and sets one boolean; the registrar can create a login and read
nothing; the website credential reads published content and is refused on
nine clinical collections. One leak is not all of them. Nothing reaches
browser JavaScript — the patient's token lives in an httpOnly signed
cookie and every call happens server-side.

### 4.4 Logging

Every read of patient-identifiable data, and every failed sign-in. Not
every read: logging the treatment price list would bury the row that
matters. Append-only, and the export of a whole record logs itself.

### 4.5 Retention

Data, per practice, with the statute cited. `GET /api/retention/due` lists
what has passed its period and **destroys nothing**.

That is the assessment, not an unfinished half. A retention period is a
minimum to keep, not a deadline to destroy: a record under a complaint, a
claim or a safeguarding matter is kept past its period *because* the
period elapsed, and a timer cannot know that. Records management
everywhere else separates the schedule from the review and the
authorisation for the same reason, and all three now exist: the schedule
in `retention_rules`, the review in `/api/retention/due`, the
authorisation in `disposals` — where a disposal cannot have been carried
out before it was authorised, and holding a record back has to say why.

What does not exist is the act. That is deliberate: shipped as a default,
it would be a default that destroys clinical records.

### 4.6 Sub-processors

Off by default, and every one is named in configuration rather than
inferred from whether credentials happen to be present. Naming a provider
without its credentials **stops the service** — falling back to a mock
would mean a practice believing it was reaching patients while every
message row said `sent`.

### 4.7 Measures **not** taken

Listed because a DPIA whose measures section contains only the things that
were done is not an assessment.

| Not built | Consequence | Why not |
|---|---|---|
| Alerting on unusual access | §3.2 is detectable after the fact and not at the time | Needs a baseline of normal, and a wrong one trains people to dismiss it |
| A technical bar on using the access log for performance management | §3.6 rests on policy | Not expressible as a permission — the same read serves both purposes |
| Address verification | §3.5 stays open | A confirmation loop on an address the patient cannot receive is worse than the risk |
| The *act* of destruction | §3.8's "kept too long" arm has a schedule, a review and a signature — and nothing that deletes | A deployment's decision, not a default. Built here, it would be a default that destroys clinical records |
| Field-level encryption of clinical free text | An operator with database access reads notes | Would break search and the constraints; the honest control is that operator access is the threat model a processor agreement covers |
| A screen-reader pass | Accessibility is asserted structurally, not experientially | Needs a person |

---

## 5. Prior consultation

Article 36 requires consulting the supervisory authority where a DPIA
indicates high residual risk that the controller cannot mitigate. On this
assessment it does not: every high-severity risk in §3 has a technical
measure and a low residual likelihood.

**That conclusion is contingent on scale.** A deployment holding many
practices' records in one database changes §3.1 from "low likelihood, high
severity" to something a controller should reassess before agreeing with
this document.

---

## 6. What a reviewer should challenge first

1. **§3.1's residual.** Two features read Postgres directly, so no policy
   is consulted on the way. One of them — the day sheet — was found serving
   a full day of patients to an account with no collection permissions at
   all, and now asks Directus which rows the caller may see. Is "asserted by
   the suite" an acceptable control for the remaining one, or should those
   queries go through the permission layer at a performance cost?
2. **§2's access-log paragraph.** Is logging every read of patient data
   proportionate, or is it surveillance of staff justified after the fact
   by a statute that does not require this much?
3. **§4.5.** The schedule, the review and the authorisation exist and
   nothing destroys anything. Is that defensible under the storage
   limitation principle in Article 5(1)(e), or does a controller have to
   be able to point at records actually having gone?
4. **§1.1's "no joint control".** The conclusion rests on one installation
   serving one practice. Does a hosted deployment serving several change it,
   and at what point does the operator become a joint controller rather than
   a processor?
5. **Absence reasons (§3.6).** Should the field exist at all, or is
   "absent" enough without a reason ever being recorded?

---

## Review

| | |
|---|---|
| Written | 14 September 2026 |
| Reviewed by a DPO | **No** |
| Reviewed by a lawyer | **No** |
| Next review | On any change to what is collected, who can read it, or where it goes — and in any case within a year |
