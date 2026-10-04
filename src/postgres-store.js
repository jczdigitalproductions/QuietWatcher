import { neon } from "@neondatabase/serverless";
import { observationSchema } from "./state.js";

function mapWatch(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    query: row.query,
    criteria: row.criteria,
    recipientEmail: row.recipient_email,
    checkIntervalMinutes: row.check_interval_minutes,
    sourceDomain: row.source_domain ?? null,
    sourceUrl: row.source_url ?? null,
    currentState: row.current_state ? observationSchema.parse(row.current_state) : null,
  };
}

export function createPostgresStore(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const sql = neon(connectionString);

  return {
    async claimDueWatches({ watchId = null, force = false }) {
      const rows = await sql`
        WITH due AS (
          SELECT w.id
          FROM quiet_watcher.watches AS w
          WHERE w.is_active
            AND (${watchId}::uuid IS NULL OR w.id = ${watchId}::uuid)
            AND (${force}::boolean OR w.next_check_at <= now())
          ORDER BY w.next_check_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        )
        UPDATE quiet_watcher.watches AS w
        SET next_check_at = now() + make_interval(mins => w.check_interval_minutes),
            updated_at = now()
        FROM due
        WHERE w.id = due.id
        RETURNING w.id, w.name, w.kind, w.query, w.criteria,
          w.recipient_email, w.check_interval_minutes, w.current_state,
          w.source_domain, w.source_url
      `;
      return rows.map(mapWatch);
    },

    async getDashboard() {
      const [watchRows, activityRows] = await Promise.all([
        sql`
          SELECT id, name, kind, query, criteria, recipient_email,
            check_interval_minutes, current_state, is_active,
            last_checked_at, next_check_at, source_domain, source_url
          FROM quiet_watcher.watches
          ORDER BY is_active DESC, next_check_at
          LIMIT 100
        `,
        sql`
          SELECT o.id, w.name AS watch_name, o.state, o.summary,
            o.source_url, o.source_title, o.observed_at,
            a.status AS alert_status
          FROM quiet_watcher.observations AS o
          JOIN quiet_watcher.watches AS w ON w.id = o.watch_id
          LEFT JOIN quiet_watcher.alert_outbox AS a ON a.observation_id = o.id
          ORDER BY o.observed_at DESC
          LIMIT 20
        `,
      ]);
      return {
        watches: watchRows.map((row) => ({
          ...mapWatch(row),
          isActive: row.is_active,
          lastCheckedAt: row.last_checked_at,
          nextCheckAt: row.next_check_at,
        })),
        recentActivity: activityRows.map((row) => ({
          id: row.id,
          watchName: row.watch_name,
          state: observationSchema.parse(row.state),
          summary: row.summary,
          sourceUrl: row.source_url,
          sourceTitle: row.source_title,
          observedAt: row.observed_at,
          alertStatus: row.alert_status,
          changed: true,
        })),
      };
    },

    async createWatch(input) {
      const rows = await sql`
        INSERT INTO quiet_watcher.watches
          (name, kind, query, criteria, recipient_email, check_interval_minutes)
        VALUES (
          ${input.name},
          ${input.kind},
          ${input.query},
          ${JSON.stringify(input.criteria)}::jsonb,
          ${input.recipientEmail},
          ${input.checkIntervalMinutes}
        )
        RETURNING id, name, kind, query, criteria, recipient_email,
          check_interval_minutes, current_state, is_active,
          last_checked_at, next_check_at, source_domain, source_url
      `;
      const row = rows[0];
      return {
        ...mapWatch(row),
        isActive: row.is_active,
        lastCheckedAt: row.last_checked_at,
        nextCheckAt: row.next_check_at,
      };
    },

    async saveObservation(candidate) {
      const { watch, state, source, fingerprint, stateChanged, shouldAlert, rebase = false } = candidate;
      if (!stateChanged) {
        await sql`
          UPDATE quiet_watcher.watches
          SET last_checked_at = now(), updated_at = now(),
              pending_state = NULL, pending_fingerprint = NULL
          WHERE id = ${watch.id}::uuid
        `;
        return;
      }

      await sql`
        WITH prior AS (
          SELECT pending_fingerprint
          FROM quiet_watcher.watches
          WHERE id = ${watch.id}::uuid
        ),
        decision AS (
          SELECT
            (${watch.kind === "price_drop" && shouldAlert && !rebase}::boolean) AS requires_confirmation,
            (${rebase}::boolean) AS is_rebase,
            (SELECT pending_fingerprint FROM prior) = ${fingerprint} AS confirmed
        ),
        inserted AS (
          INSERT INTO quiet_watcher.observations
            (watch_id, fingerprint, state, summary, source_url, source_title, source_published_at)
          SELECT
            ${watch.id}::uuid,
            ${fingerprint},
            ${JSON.stringify(state)}::jsonb,
            ${state.summary},
            ${source.url},
            ${source.title},
            ${source.publishedDate}::timestamptz
          WHERE NOT (
            SELECT requires_confirmation AND NOT COALESCE(confirmed, false) AND NOT is_rebase
            FROM decision
          )
          RETURNING id
        ),
        updated AS (
          UPDATE quiet_watcher.watches AS w
          SET current_state = CASE
                WHEN EXISTS (SELECT 1 FROM inserted) THEN ${JSON.stringify(state)}::jsonb
                ELSE w.current_state
              END,
              source_domain = COALESCE(w.source_domain, ${source.domain}),
              source_url = COALESCE(w.source_url, ${source.canonicalUrl}),
              pending_state = CASE
                WHEN (SELECT requires_confirmation AND NOT COALESCE(confirmed, false) AND NOT is_rebase FROM decision)
                  THEN ${JSON.stringify(state)}::jsonb
                ELSE NULL
              END,
              pending_fingerprint = CASE
                WHEN (SELECT requires_confirmation AND NOT COALESCE(confirmed, false) AND NOT is_rebase FROM decision)
                  THEN ${fingerprint}
                ELSE NULL
              END,
              last_checked_at = now(),
              updated_at = now()
          WHERE w.id = ${watch.id}::uuid
          RETURNING w.id
        ),
        queued AS (
          INSERT INTO quiet_watcher.alert_outbox
            (watch_id, observation_id, recipient_email)
          SELECT ${watch.id}::uuid, inserted.id, ${watch.recipientEmail}
          FROM inserted
          WHERE ${shouldAlert}::boolean AND NOT (SELECT is_rebase FROM decision)
          ON CONFLICT (observation_id) DO NOTHING
          RETURNING id
        )
        SELECT
          (SELECT id FROM inserted) AS observation_id,
          (SELECT id FROM queued) AS alert_id
      `;
    },

    async resetPendingObservation(watchId) {
      await sql`
        UPDATE quiet_watcher.watches
        SET pending_state = NULL, pending_fingerprint = NULL,
            last_checked_at = now(), updated_at = now()
        WHERE id = ${watchId}::uuid
      `;
    },

    async listPendingAlerts() {
      const rows = await sql`
        SELECT a.id, a.recipient_email, w.name AS watch_name,
          o.state, o.summary, o.source_url, o.source_title
        FROM quiet_watcher.alert_outbox AS a
        JOIN quiet_watcher.watches AS w ON w.id = a.watch_id
        JOIN quiet_watcher.observations AS o ON o.id = a.observation_id
        WHERE a.status = 'pending'
        ORDER BY a.created_at
        LIMIT 100
      `;
      return rows.map((row) => ({
        id: row.id,
        recipientEmail: row.recipient_email,
        watchName: row.watch_name,
        state: observationSchema.parse(row.state),
        summary: row.summary,
        sourceUrl: row.source_url,
        sourceTitle: row.source_title,
      }));
    },

    async markAlertAttempted(id) {
      await sql`
        UPDATE quiet_watcher.alert_outbox
        SET attempt_count = attempt_count + 1, last_attempt_at = now(), last_error = NULL
        WHERE id = ${id}::uuid AND status = 'pending'
      `;
    },

    async markAlertFailed(id, error) {
      const message = error instanceof Error ? error.message : String(error);
      await sql`
        UPDATE quiet_watcher.alert_outbox
        SET last_error = ${message}
        WHERE id = ${id}::uuid AND status = 'pending'
      `;
    },

    async markAlertSent(id) {
      await sql`
        UPDATE quiet_watcher.alert_outbox
        SET status = 'sent', sent_at = now(), last_error = NULL
        WHERE id = ${id}::uuid AND status = 'pending'
      `;
    },
  };
}
