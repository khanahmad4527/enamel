/**
 * An iCalendar feed, written by hand.
 *
 * `real`, with no account anywhere: an ICS feed is a text file over HTTP,
 * and Google Calendar, Outlook and Apple Calendar all subscribe to one.
 * That makes it the only calendar integration worth building first — it
 * works with every calendar rather than with one of them, and it needs no
 * OAuth dance, no refresh tokens and no app review.
 *
 * The details below are the ones that make a feed work rather than
 * almost-work, and every one of them is a bug somebody has shipped:
 *
 *   UID must be stable for the life of the appointment. A feed that
 *   generates a fresh UID each poll does not update an event — it adds a
 *   second one, every time, forever. The appointment's own uuid is the
 *   obvious stable thing and is therefore the right one.
 *
 *   SEQUENCE must increase when an event changes, or a subscriber that
 *   has already seen that UID keeps what it has and ignores the update.
 *   Derived here from the row's `date_updated`, so it moves exactly when
 *   the appointment does.
 *
 *   A cancelled appointment has to be *published as cancelled*, not
 *   dropped. A subscriber that stops seeing a UID does not remove the
 *   event — most treat a missing UID as "not in this window" — so
 *   deleting the row from the feed leaves a ghost appointment in the
 *   clinician's phone for a patient who is not coming.
 *
 *   Lines fold at 75 octets. Long ones are not rejected loudly; they are
 *   truncated or mangled, differently by each client.
 *
 *   Times are UTC with a trailing Z. A practice spanning Amsterdam and
 *   Dubai makes floating local times ambiguous, and shipping a correct
 *   VTIMEZONE block by hand is a larger undertaking than it looks.
 */

export type FeedEvent = {
  uid: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  cancelled: boolean;
  sequence: number;
  updatedAt: string;
};

/** RFC 5545 §3.1: fold at 75 octets, continuation lines start with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let index = 0;
  while (index < bytes.length) {
    // 75 on the first line, 74 afterwards — the leading space counts.
    const take = out.length === 0 ? 75 : 74;
    let end = Math.min(index + take, bytes.length);
    // Never split a multi-byte character: walk back off a continuation
    // byte. A surname with an accent in it is not an edge case.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push((out.length === 0 ? "" : " ") + bytes.subarray(index, end).toString("utf8"));
    index = end;
  }
  return out.join("\r\n");
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline. */
function escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(name: string, events: FeedEvent[], domain = "enamel.dev"): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Enamel//Practice diary//EN",
    "CALSCALE:GREGORIAN",
    // A hint, not a contract: most clients poll on their own schedule
    // whatever this says. Worth sending because the ones that honour it
    // are the ones that would otherwise poll every minute.
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    `X-WR-CALNAME:${escape(name)}`,
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}@${domain}`,
      `DTSTAMP:${stamp(event.updatedAt)}`,
      `DTSTART:${stamp(event.startsAt)}`,
      `DTEND:${stamp(event.endsAt)}`,
      `SEQUENCE:${event.sequence}`,
      `SUMMARY:${escape(event.summary)}`,
      `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      // Cancelled events are published, not omitted — see the note above.
      ...(event.cancelled ? ["METHOD:CANCEL"] : []),
      ...(event.description ? [`DESCRIPTION:${escape(event.description)}`] : []),
      ...(event.location ? [`LOCATION:${escape(event.location)}`] : []),
      // A clinician's diary is not a public calendar.
      "CLASS:PRIVATE",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  // CRLF throughout. Some clients tolerate bare newlines; enough do not.
  return lines.map(fold).join("\r\n") + "\r\n";
}
