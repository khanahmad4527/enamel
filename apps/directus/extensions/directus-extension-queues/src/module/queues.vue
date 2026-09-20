<script setup lang="ts">
import { EnamelState, installEnamelUi } from "@enamel/extension-ui";
import { onMounted, ref } from "vue";
import { useApi } from "@directus/extensions-sdk";

/**
 * The way in, and an honest account of what is on the other side.
 *
 * This page holds no queue data and never will. It asks the core service
 * for a one-time link and opens it; everything about a job — who it is
 * being sent to, what it says — lives on the board, which is a separate
 * origin behind a separate door. Rendering job payloads here would put
 * patients' names and phone numbers onto a page reachable by anybody the
 * admin lets in, which is a wider audience than the board's own.
 */

const api = useApi();
installEnamelUi();

type Board = {
  enabled: boolean;
  route: string;
  sessionMinutes: number;
  /**
   * Whether this caller may open the board.
   *
   * Deliberately not `isAdmin`. An administrator may, and so may anybody
   * holding the Queue operator policy, which grants the board and not one
   * clinical collection. The service answers the question; this page does
   * not reconstruct how it was answered.
   */
  youMayOpen: boolean;
};

/**
 * The refusal, written here rather than waited for.
 *
 * Same shape and same rendering as every other refusal in the admin — see
 * `refusalFrom` in @enamel/extension-ui — because a rule working as
 * designed is a **condition**, not an error, and must not be drawn in red
 * with an alert icon. What differs is that this one is known before the
 * request instead of after it.
 */
const MAY_NOT_OPEN = {
  kind: "condition" as const,
  title: "Your role does not open this",
  body:
    "Job payloads contain patients' names and the addresses they are being " +
    "written to, so the board is opened by an administrator or by somebody " +
    "holding the Queue operator policy — which grants this and nothing else.",
  hint: "This is the access model working, not a fault.",
};

const board = ref<Board | null>(null);
const checking = ref(true);
const opening = ref(false);
/** The failure itself, not a sentence out of it — the status is the part
    that separates "you may not open this" from "the service is down". */
const failure = ref<unknown>(null);
/** Shown only when a popup blocker ate the tab. */
const fallbackUrl = ref("");

onMounted(async () => {
  try {
    board.value = (await api.get("/queue-board/status")).data as Board;
  } catch (e) {
    failure.value = e;
  } finally {
    checking.value = false;
  }
});

async function open(): Promise<void> {
  opening.value = true;
  failure.value = null;
  fallbackUrl.value = "";

  /*
   * The tab is opened *before* the request, empty, and pointed at the URL
   * afterwards.
   *
   * A `window.open` that happens after an `await` is no longer part of
   * the click that caused it, and every browser's popup blocker stops it.
   * Opening synchronously keeps the user gesture; if the blocker stopped
   * even that, `tab` is null and the link is offered instead of nothing
   * happening at all.
   *
   * **No `noopener` in the feature string.** It looks like the safe
   * spelling and it is the one thing that breaks this: a window opened
   * with `noopener` returns `null`, by specification, so there is nothing
   * to point at the URL and every visitor lands in the blocked-popup
   * branch. The reverse-tabnabbing this guards against is handled on the
   * line below instead, after the navigation has been set.
   */
  const tab = window.open("", "_blank");
  try {
    const res = await api.post("/queue-board/open");
    const url = (res.data as { url: string }).url;
    if (tab) {
      tab.location.href = url;
      // Same protection `noopener` would have given, applied once the
      // handle has done its job: the new tab cannot reach back and
      // navigate this one.
      tab.opener = null;
    } else {
      fallbackUrl.value = url;
    }
  } catch (e) {
    tab?.close();
    failure.value = e;
  } finally {
    opening.value = false;
  }
}
</script>

<template>
  <private-view title="Queues">
    <template #navigation>
      <div class="qb-nav enamel-scope">
        <p class="qb-hint">
          Bull Board, served by the core service. It shows what is waiting, what
          is being retried and what has failed — reminders, outbound messages,
          and the timers behind both.
        </p>
        <p class="qb-hint qb-quiet">
          Opened by an administrator, or by somebody holding the Queue operator
          policy — a grant that opens this board and not one clinical
          collection. The payloads carry patients' names either way.
        </p>
      </div>
    </template>

    <div class="qb enamel-scope">
      <EnamelState
        :loading="checking"
        :error="failure"
        loading-label="Asking the core service"
        fill
      />

      <EnamelState
        v-if="!checking && !failure && board?.enabled && !board.youMayOpen"
        :refusal="MAY_NOT_OPEN"
        fill
      />

      <template v-if="!checking && !failure && (board?.youMayOpen || !board?.enabled)">
        <div v-if="board && !board.enabled" class="qb-card">
          <h2 class="qb-h">The board is switched off</h2>
          <p class="qb-p">
            This deployment runs with <code>QUEUE_BOARD_ENABLED=false</code>. The
            queues are still working — nothing about delivery depends on the
            board — but there is no page to open.
          </p>
        </div>

        <div v-else class="qb-card">
          <h2 class="qb-h">Open the queue board</h2>
          <p class="qb-p">
            A link is made for you now, good for one visit and about a minute.
            It opens in a new tab and signs you in there for
            {{ board?.sessionMinutes ?? 30 }} minutes.
          </p>
          <p class="qb-p qb-quiet">
            You are not asked for a second password. The core service is handed
            the token this browser already has, checks with Directus that it may
            open the board, and issues a ticket that is destroyed the moment it
            is used — so the link left in your history is already dead.
          </p>

          <div class="qb-actions">
            <v-button :loading="opening" @click="open">Open in a new tab</v-button>
          </div>

          <p v-if="fallbackUrl" class="qb-p qb-blocked">
            Your browser blocked the new tab.
            <a :href="fallbackUrl" target="_blank" rel="noopener">Open it from here</a>
            — this link expires in under a minute.
          </p>
        </div>

        <div class="qb-card qb-card--quiet">
          <h3 class="qb-h3">What is on it</h3>
          <dl class="qb-list">
            <dt>reminders</dt>
            <dd>One job per appointment reminder, retried five times. What is left on the failed set is a patient who has not been told.</dd>
            <dt>messages</dt>
            <dd>Everything outbound — email, SMS, WhatsApp — with the recipient and the body.</dd>
            <dt>reminder-sweep</dt>
            <dd>The timer that looks for appointments coming due. If it is empty, nothing is being found at all.</dd>
            <dt>message-sweeps</dt>
            <dd>The timers behind recalls and chasing overdue invoices.</dd>
          </dl>
        </div>
      </template>
    </div>
  </private-view>
</template>

<style scoped>
.qb { padding: 24px 32px 64px; max-width: 720px; }
.qb-nav { padding: 12px 16px; }
.qb-hint { margin: 0 0 12px; color: var(--en-ink-dim); font-size: 13px; line-height: 1.5; }
.qb-quiet { opacity: 0.8; }

.qb-card {
  background: var(--en-sunken);
  border: 1px solid var(--en-line);
  border-radius: var(--en-radius);
  padding: 22px 24px;
  margin-bottom: 18px;
}
.qb-card--quiet { background: none; }

.qb-h { margin: 0 0 8px; font-size: 17px; font-weight: 600; color: var(--en-ink-strong); }
.qb-h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; letter-spacing: 0.08em;
         text-transform: uppercase; color: var(--en-ink-dim); }
.qb-p { margin: 0 0 10px; color: var(--en-ink); font-size: 14px; line-height: 1.6; }
.qb-actions { margin-top: 16px; }
.qb-blocked { margin-top: 14px; color: var(--en-warning); }

/* `minmax(0, 1fr)`, not `1fr`. A grid track defaults to a minimum of
   min-content, so the description column refuses to shrink and the admin's
   own `text-overflow` clips the sentence instead of wrapping it — which is
   how three of these four read as "One job per appointment reminder,
   retried five times. What is left on the fa…". */
.qb-list { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 18px; }
.qb-list dt {
  font-family: var(--theme--fonts--monospace--font-family, ui-monospace, monospace);
  font-size: 13px; color: var(--en-ink-strong); white-space: nowrap;
}
.qb-list dd {
  margin: 0; min-width: 0;
  font-size: 13px; line-height: 1.55; color: var(--en-ink-dim);
  white-space: normal; overflow-wrap: anywhere; text-overflow: clip;
}

code {
  background: var(--en-surface); padding: 2px 6px;
  border-radius: 4px; font-size: 13px;
}

@media (max-width: 600px) {
  .qb { padding: 20px; }
  .qb-list { grid-template-columns: 1fr; gap: 2px 0; }
  .qb-list dd { margin-bottom: 12px; }
}
</style>
