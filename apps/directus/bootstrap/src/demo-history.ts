import { Client } from "pg";
import { DB_HOST, DB_PORT, DB_DATABASE, DB_USER, DB_PASSWORD } from "./env.js";
import { log } from "./log.js";

/**
 * Giving the demo a past.
 *
 * Everything the seed writes is created in the same run, so `date_created`
 * is "a moment ago" for every row. That is not wrong, and it makes two
 * screens look broken: patient growth is a single bar, and recall
 * conversion is zero out of three because no recall has had time to be
 * booked. A reviewer reads both as bugs, and they would be right to —
 * a dashboard whose charts have one data point is indistinguishable from
 * one whose query is wrong.
 *
 * This runs in SQL rather than through the API because `date_created` is a
 * Directus system field: the platform sets it on write and no payload key
 * overrides it. That is the correct behaviour for a real system and an
 * obstacle for a demo, which is the whole reason this file is separate
 * and named for what it is.
 *
 * Nothing here invents clinical facts. It moves *when* rows were created
 * and books some recalls that were already due — the sort of thing that
 * would have happened on its own had the practice been running for a year.
 */

async function connect(): Promise<Client | null> {
  const client = new Client({
    host: DB_HOST, port: DB_PORT, database: DB_DATABASE,
    user: DB_USER, password: DB_PASSWORD,
  });
  try {
    await client.connect();
    return client;
  } catch (e) {
    log.warn(`demo history skipped — cannot reach Postgres (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

export async function spreadDemoHistory(): Promise<void> {
  const db = await connect();
  if (!db) return;

  try {
    // Spread across the eleven months the growth chart actually shows.
    // An earlier version weighted them ^1.4 toward the past, which pushed
    // most of them outside the twelve-month window and left a chart with
    // four bars in it — technically a trend, visibly an accident.
    const patients = await db.query(`
      UPDATE patients p
         SET date_created = now()
           - ((floor(random() * 11))::int || ' months')::interval
           - ((floor(random() * 28))::int || ' days')::interval
       WHERE p.date_created > now() - interval '1 day'`);

    // Recalls that came due in the past mostly got booked. Leaving every
    // one unbooked reported 0% conversion, which reads as a broken query
    // rather than as a practice with nothing overdue.
    const recalls = await db.query(`
      UPDATE recalls r
         SET date_scheduled = r.date_due + ((floor(random() * 14))::int || ' days')::interval
       WHERE r.date_due < current_date
         AND r.date_scheduled IS NULL
         AND NOT r.is_disabled
         AND random() < 0.75`);

    /*
     * And one patient pushed twenty-one years into the past.
     *
     * The retention review has nothing to show otherwise: every other row
     * in this seed was written today or within the last year, so nothing
     * has ever been past its period and the page always says zero. A
     * feature that cannot be seen working is a feature nobody can tell is
     * broken — and this one exists to be looked at.
     *
     * Twenty-one, not twenty. The Dutch period is twenty years from the
     * last contact, so a patient last seen exactly twenty years ago is
     * due *today* and the demo would flip depending on the hour it ran.
     *
     * The dates are moved in SQL for the same reason the block above is:
     * `date_created`, `date_updated` and the rest are Directus system
     * fields, and no payload key overrides them.
     */
    /*
     * Only patients that have not already been moved.
     *
     * The first version selected every `-ARCH` patient and subtracted
     * twenty-one years, on every seed run. The second run made them
     * forty-two years old, which is past the UAE's twenty-five as well —
     * and the check asserting the two jurisdictions disagree started
     * failing because both now agreed. The seed is idempotent everywhere
     * else and this had to be too.
     */
    const archived = await db.query(`
      SELECT p.id FROM patients p
       WHERE p.reference LIKE '%-ARCH'
         AND p.date_created > now() - interval '10 years'`);
    let moved = 0;
    for (const row of archived.rows as Array<{ id: string }>) {
      const back = "interval '21 years'";
      for (const [table, columns] of [
        ["clinical_notes", ["written_on", "date_created"]],
        ["consents", ["signed_on", "date_created"]],
        ["invoices", ["issued_at", "paid_at", "date_created"]],
        ["messages", ["sent_at", "date_created"]],
        ["patients", ["date_created"]],
      ] as Array<[string, string[]]>) {
        const sets = columns.map((c) => `${c} = ${c} - ${back}`).join(", ");
        const where = table === "patients" ? "id = $1" : "patient = $1";
        const result = await db.query(
          `UPDATE ${table} SET ${sets} WHERE ${where}`, [row.id],
        );
        moved += result.rowCount ?? 0;
      }

      /*
       * A few audit-log rows old enough to be due as well.
       *
       * Inserted rather than back-dated: `access_log` carries an
       * append-only trigger, so an UPDATE on it is refused — which is
       * exactly the behaviour that makes the log worth having, and the
       * reason this is the one table here that gets INSERTs.
       */
      await db.query(
        `INSERT INTO access_log (id, action, "user", collection, patient, item_count, date_created)
         SELECT gen_random_uuid(), 'read', u.id, 'patients', $1, 1, now() - interval '3 years'
           FROM directus_users u WHERE u.role IS NOT NULL LIMIT 1
         ON CONFLICT DO NOTHING`,
        [row.id],
      );
    }

    log.made(
      `  demo history: ${patients.rowCount ?? 0} patients spread over 18 months, ` +
        `${recalls.rowCount ?? 0} past recalls booked, ` +
        `${archived.rowCount ?? 0} archived patients moved 21 years back (${moved} rows)`,
    );
  } catch (e) {
    log.fail(`demo history: ${e instanceof Error ? e.message : e}`);
  } finally {
    await db.end().catch(() => {});
  }
}
