import { Pool, PoolClient } from "pg";
import bcrypt from "bcrypt";
import {
  toIsoDate,
  type MeetingInput,
  type SessionInput,
  type SessionStatus,
} from "./recordings/sessionInfo";

export interface RecordingInput {
  sessionId: string;
  filename: string;
  content: Buffer;
  sessionName: string | null;
  sessionType: string | null;
  meetingKey: number | null;
  sessionKey: number | null;
  qualifyingPart: number | null;
  source: "manual" | "recorder";
}

export interface MeetingFilters {
  year?: number | null;
}

export interface SessionFilters {
  meetingKey?: number | null;
  year?: number | null;
  status?: SessionStatus | null;
  /** true = only sessions without meeting, false = only sessions with meeting. */
  unassigned?: boolean | null;
}

const MEETING_SELECT = `
  SELECT
    m.meeting_key AS "meetingKey",
    m.name,
    m.official_name AS "officialName",
    m.location,
    m.country_key AS "countryKey",
    m.country_code AS "countryCode",
    m.country_name AS "countryName",
    m.circuit_key AS "circuitKey",
    m.circuit_short_name AS "circuitShortName",
    m.year,
    (SELECT COUNT(*)::int FROM sessions s WHERE s.meeting_key = m.meeting_key) AS "sessionCount",
    (SELECT COUNT(*)::int FROM session_recordings r WHERE r.meeting_key = m.meeting_key) AS "recordingCount",
    (SELECT MIN(s.start_date) FROM sessions s WHERE s.meeting_key = m.meeting_key) AS "firstSessionAt",
    (SELECT MAX(s.start_date) FROM sessions s WHERE s.meeting_key = m.meeting_key) AS "lastSessionAt"
  FROM meetings m
`;

const SESSION_SELECT = `
  SELECT
    s.session_key AS "sessionKey",
    s.meeting_key AS "meetingKey",
    m.name AS "meetingName",
    s.name,
    s.type,
    s.start_date AS "startDate",
    s.end_date AS "endDate",
    s.status,
    (SELECT COUNT(*)::int FROM session_recordings r WHERE r.session_key = s.session_key) AS "recordingCount",
    EXISTS (
      SELECT 1 FROM session_recordings r WHERE r.session_key = s.session_key
    ) AS "hasRecording"
  FROM sessions s
  LEFT JOIN meetings m ON m.meeting_key = s.meeting_key
`;

export class DatabaseService {
  private pool: Pool;
  readonly ready: Promise<void>;
  private readonly SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || "10");

  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      port: Number(process.env.POSTGRES_PORT),
    });
    this.ready = this.initializeSchema();
  }

  async initializeSchema() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TABLE IF NOT EXISTS roles (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) UNIQUE NOT NULL
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role_id INTEGER REFERENCES roles(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        INSERT INTO roles (name)
        VALUES ('base'), ('premium'), ('admin')
        ON CONFLICT (name) DO NOTHING;
      `);

      // Password recovery: a sha256 hash of the emailed token (not the raw
      // token itself, so a DB leak alone can't be replayed) plus its expiry.
      await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS reset_token_hash TEXT,
        ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP WITH TIME ZONE;
      `);

      // Drop legacy chat customization columns: the feature was removed but
      // existing databases (created before this cleanup) may still have
      // them. Dropping the columns doesn't touch existing user rows.
      await client.query(`
        ALTER TABLE users
        DROP COLUMN IF EXISTS chat_color,
        DROP COLUMN IF EXISTS chat_badge;
      `);

      // Drop the pinned chat messages feature: announcements are now handled
      // externally (e.g. Discord), so the table is no longer needed. This
      // only drops chat_pinned_messages, leaving users/roles untouched.
      await client.query(`
        DROP TABLE IF EXISTS chat_pinned_messages;
      `);

      // Roles allowed to receive full telemetry data (transcriptions/translations)
      // over the websocket. Admin-configurable via PUT /settings/full-data-roles.
      await client.query(`
        CREATE TABLE IF NOT EXISTS full_data_roles (
          role_id INTEGER PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE
        );
      `);

      // Default to every existing role, matching the current "any logged-in
      // user" behavior until an admin narrows it down.
      await client.query(`
        INSERT INTO full_data_roles (role_id)
        SELECT id FROM roles
        ON CONFLICT (role_id) DO NOTHING;
      `);

      // Generic runtime-configurable settings store. First use case: the
      // Discord invite link, which expires every 30 days and previously
      // required editing .env and redeploying the frontend to rotate.
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS session_recordings (
          session_id TEXT PRIMARY KEY,
          filename VARCHAR(245) UNIQUE NOT NULL,
          content BYTEA NOT NULL,
          session_name TEXT,
          session_type TEXT,
          saved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        ALTER TABLE session_recordings
          ADD COLUMN IF NOT EXISTS session_name TEXT,
          ADD COLUMN IF NOT EXISTS session_type TEXT;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS session_recordings_saved_at_idx
        ON session_recordings (saved_at DESC);
      `);

      // Prode feature removed: clean up legacy tables if they exist.
      // `grand_prix` is not reused by the replay feature, so it stays here as
      // residue. `sessions` is intentionally NOT listed: it is a live table
      // for recorded sessions and must survive restarts.
      await client.query(`
        DROP TABLE IF EXISTS predictions, session_results, user_season_points, grand_prix, drivers, seasons CASCADE;
      `);

      // One-time migration for the legacy prode `sessions` table. The old
      // table does not have the new (session_key, meeting_key) columns. This
      // removes the residue from databases created before the replay feature
      // while keeping the new table's data across restarts.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'sessions'
          ) AND (
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sessions'
              AND column_name IN ('session_key', 'meeting_key')
          ) < 2 THEN
            DROP TABLE sessions CASCADE;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS meetings (
          meeting_key INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          official_name TEXT,
          location TEXT,
          country_key INTEGER,
          country_code VARCHAR(10),
          country_name TEXT,
          circuit_key INTEGER,
          circuit_short_name TEXT,
          year INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_key INTEGER PRIMARY KEY,
          meeting_key INTEGER,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          start_date TIMESTAMPTZ,
          end_date TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'scheduled'
            CHECK (status IN ('scheduled', 'started', 'completed', 'aborted')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Sessions can be detached from a meeting. The FK uses SET NULL so a
      // meeting deletion never cascades into recorded sessions by accident;
      // the explicit DELETE endpoints decide whether to detach or cascade.
      await client.query(`
        ALTER TABLE sessions ALTER COLUMN meeting_key DROP NOT NULL;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'sessions_meeting_key_fkey'
              AND conrelid = 'sessions'::regclass
          ) THEN
            ALTER TABLE sessions DROP CONSTRAINT sessions_meeting_key_fkey;
          END IF;

          ALTER TABLE sessions
            ADD CONSTRAINT sessions_meeting_key_fkey
            FOREIGN KEY (meeting_key) REFERENCES meetings(meeting_key)
            ON DELETE SET NULL;
        END $$;
      `);

      await client.query(`
        ALTER TABLE session_recordings
          ADD COLUMN IF NOT EXISTS meeting_key INTEGER,
          ADD COLUMN IF NOT EXISTS session_key INTEGER,
          ADD COLUMN IF NOT EXISTS qualifying_part INTEGER,
          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'session_recordings_source_check'
              AND conrelid = 'session_recordings'::regclass
          ) THEN
            ALTER TABLE session_recordings
              ADD CONSTRAINT session_recordings_source_check
              CHECK (source IN ('manual', 'recorder'));
          END IF;
        END $$;
      `);

      // Keep the denormalized recording keys coherent before enforcing them.
      // Recordings that point to a session that no longer exists are moved to
      // the "ungrouped" bucket instead of making the migration fail.
      await client.query(`
        UPDATE session_recordings sr
        SET session_key = NULL, meeting_key = NULL
        WHERE sr.session_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sessions s WHERE s.session_key = sr.session_key
          );
      `);

      await client.query(`
        UPDATE session_recordings sr
        SET meeting_key = s.meeting_key
        FROM sessions s
        WHERE sr.session_key = s.session_key
          AND sr.meeting_key IS DISTINCT FROM s.meeting_key;
      `);

      await client.query(`
        UPDATE session_recordings
        SET meeting_key = NULL
        WHERE session_key IS NULL AND meeting_key IS NOT NULL;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'session_recordings_session_key_fkey'
              AND conrelid = 'session_recordings'::regclass
          ) THEN
            ALTER TABLE session_recordings
              ADD CONSTRAINT session_recordings_session_key_fkey
              FOREIGN KEY (session_key) REFERENCES sessions(session_key)
              ON DELETE SET NULL;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'session_recordings_meeting_key_fkey'
              AND conrelid = 'session_recordings'::regclass
          ) THEN
            ALTER TABLE session_recordings
              ADD CONSTRAINT session_recordings_meeting_key_fkey
              FOREIGN KEY (meeting_key) REFERENCES meetings(meeting_key)
              ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_meeting
        ON sessions (meeting_key, start_date);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_recordings_session_key
        ON session_recordings (session_key);
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_recordings_session_part_uniq
        ON session_recordings (session_key, COALESCE(qualifying_part, 0))
        WHERE session_key IS NOT NULL;
      `);

      // Seed the initial Discord link from env on first boot only; after
      // that, it's managed exclusively via PUT /config/discord-link.
      if (process.env.DISCORD_INVITE_URL) {
        await client.query(
          `INSERT INTO app_config (key, value)
           VALUES ('discord_invite_url', $1)
           ON CONFLICT (key) DO NOTHING`,
          [process.env.DISCORD_INVITE_URL],
        );
      }

      // Create admin user if it doesn't exist
      await this.createAdminUserIfNotExists(client);

      await client.query("COMMIT");
      console.log("Database schema initialized successfully.");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error initializing the database:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createAdminUserIfNotExists(client: any) {
    const adminUsername = process.env.POSTGRES_ADMIN_USER || "admin";
    const adminPassword = process.env.POSTGRES_ADMIN_PASSWORD || "admin123";
    const adminEmail = process.env.POSTGRES_ADMIN_EMAIL || "admin@example.com";

    try {
      // Check if admin user already exists
      const checkUser = await client.query(
        "SELECT id FROM users WHERE username = $1",
        [adminUsername],
      );

      if (checkUser.rows.length === 0) {
        // Hash the password
        const passwordHash = await bcrypt.hash(adminPassword, this.SALT_ROUNDS);

        // Insert admin user with role_id 3 (admin)
        await client.query(
          `INSERT INTO users (username, email, password_hash, role_id)
           VALUES ($1, $2, $3, 3)
           ON CONFLICT (username) DO NOTHING`,
          [adminUsername, adminEmail, passwordHash],
        );

        console.log(`Admin user '${adminUsername}' created successfully.`);
      }
    } catch (error) {
      console.error("Error creating admin user:", error);
      throw error;
    }
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertMeetingWithClient(
    client: PoolClient,
    meeting: MeetingInput,
  ): Promise<void> {
    await client.query(
      `INSERT INTO meetings (
         meeting_key, name, official_name, location,
         country_key, country_code, country_name, circuit_key,
         circuit_short_name, year
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (meeting_key) DO UPDATE SET
         name = EXCLUDED.name,
         official_name = EXCLUDED.official_name,
         location = EXCLUDED.location,
         country_key = EXCLUDED.country_key,
         country_code = EXCLUDED.country_code,
         country_name = EXCLUDED.country_name,
         circuit_key = EXCLUDED.circuit_key,
         circuit_short_name = EXCLUDED.circuit_short_name,
         year = EXCLUDED.year,
         updated_at = CURRENT_TIMESTAMP`,
      [
        meeting.meetingKey,
        meeting.name,
        meeting.officialName,
        meeting.location,
        meeting.countryKey,
        meeting.countryCode,
        meeting.countryName,
        meeting.circuitKey,
        meeting.circuitShortName,
        meeting.year,
      ],
    );
  }

  private async upsertSessionWithClient(
    client: PoolClient,
    session: SessionInput,
  ): Promise<void> {
    await client.query(
      `INSERT INTO sessions (
         session_key, meeting_key, name, type, start_date, end_date, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_key) DO UPDATE SET
         meeting_key = EXCLUDED.meeting_key,
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        session.sessionKey,
        session.meetingKey,
        session.name,
        session.type,
        session.startDate,
        session.endDate,
        session.status,
      ],
    );

    // meeting_key is denormalized on recordings for the flat list and the
    // meeting counts. Keep it in sync every time a session is saved.
    await client.query(
      `UPDATE session_recordings
       SET meeting_key = $2
       WHERE session_key = $1`,
      [session.sessionKey, session.meetingKey],
    );
  }

  async upsertMeeting(meeting: MeetingInput): Promise<void> {
    await this.withTransaction((client) =>
      this.upsertMeetingWithClient(client, meeting),
    );
  }

  async upsertSession(session: SessionInput): Promise<void> {
    await this.withTransaction((client) =>
      this.upsertSessionWithClient(client, session),
    );
  }


  async saveRecording(recording: RecordingInput): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO session_recordings (
         session_id, filename, content, session_name, session_type,
         meeting_key, session_key, qualifying_part, source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (session_id) DO UPDATE SET
         filename = EXCLUDED.filename,
         content = EXCLUDED.content,
         session_name = COALESCE(EXCLUDED.session_name, session_recordings.session_name),
         session_type = COALESCE(EXCLUDED.session_type, session_recordings.session_type),
         meeting_key = COALESCE(EXCLUDED.meeting_key, session_recordings.meeting_key),
         session_key = COALESCE(EXCLUDED.session_key, session_recordings.session_key),
         qualifying_part = COALESCE(EXCLUDED.qualifying_part, session_recordings.qualifying_part),
         source = EXCLUDED.source,
         saved_at = CURRENT_TIMESTAMP
       RETURNING
         session_id AS "sessionId",
         filename,
         session_name AS "sessionName",
         session_type AS "sessionType",
         meeting_key AS "meetingKey",
         session_key AS "sessionKey",
         qualifying_part AS "qualifyingPart",
         source,
         saved_at AS "savedAt",
         octet_length(content) AS "sizeBytes"`,
      [
        recording.sessionId,
        recording.filename,
        recording.content,
        recording.sessionName,
        recording.sessionType,
        recording.meetingKey,
        recording.sessionKey,
        recording.qualifyingPart,
        recording.source,
      ],
    );
    return result.rows[0];
  }

  async getRecordingMetadata(sessionId: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT
         session_id AS "sessionId",
         filename,
         session_name AS "sessionName",
         session_type AS "sessionType",
         meeting_key AS "meetingKey",
         session_key AS "sessionKey",
         qualifying_part AS "qualifyingPart",
         source,
         saved_at AS "savedAt",
         octet_length(content) AS "sizeBytes"
       FROM session_recordings
       WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  async updateRecordingAssociation(
    sessionId: string,
    association: {
      sessionKey: number | null;
      meetingKey: number | null;
      sessionName: string | null;
      sessionType: string | null;
      qualifyingPart: number | null;
    },
  ): Promise<any | null> {
    const result = await this.pool.query(
      `UPDATE session_recordings AS sr
       SET session_key = $2,
           meeting_key = $3,
           session_name = $4,
           session_type = $5,
           qualifying_part = $6
       WHERE sr.session_id = $1
       RETURNING
         sr.session_id AS "sessionId",
         sr.filename,
         sr.session_name AS "sessionName",
         sr.session_type AS "sessionType",
         sr.meeting_key AS "meetingKey",
         sr.session_key AS "sessionKey",
         sr.qualifying_part AS "qualifyingPart",
         sr.source,
         sr.saved_at AS "savedAt",
         octet_length(sr.content) AS "sizeBytes"`,
      [
        sessionId,
        association.sessionKey,
        association.meetingKey,
        association.sessionName,
        association.sessionType,
        association.qualifyingPart,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getRecordingPrefix(
    sessionId: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    const result = await this.pool.query(
      `SELECT substring(content FROM 1 FOR $2) AS content
       FROM session_recordings
       WHERE session_id = $1`,
      [sessionId, maxBytes],
    );
    return result.rows[0]?.content ?? null;
  }

  async deleteRecording(sessionId: string): Promise<any | null> {
    const result = await this.pool.query(
      `DELETE FROM session_recordings
       WHERE session_id = $1
       RETURNING
         session_id AS "sessionId",
         filename,
         session_name AS "sessionName",
         session_type AS "sessionType",
         meeting_key AS "meetingKey",
         session_key AS "sessionKey",
         qualifying_part AS "qualifyingPart",
         source,
         saved_at AS "savedAt",
         octet_length(content) AS "sizeBytes"`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  async linkRecording(
    sessionId: string,
    input: {
      sessionKey: number;
      qualifyingPart: number | null;
      hasQualifyingPart: boolean;
      meeting: MeetingInput | null;
      session: SessionInput | null;
    },
  ): Promise<
    | { status: "recording-not-found" }
    | { status: "session-not-found" }
    | {
        status: "ok";
        recording: any;
        session: any | null;
        meeting: any | null;
      }
  > {
    return this.withTransaction(async (client) => {
      const recordingResult = await client.query(
        `SELECT
           session_name AS "sessionName",
           session_type AS "sessionType",
           qualifying_part AS "qualifyingPart"
         FROM session_recordings
         WHERE session_id = $1
         FOR UPDATE`,
        [sessionId],
      );
      const existingRecording = recordingResult.rows[0];
      if (!existingRecording) return { status: "recording-not-found" };

      const existingSessionResult = await client.query(
        `SELECT * FROM sessions WHERE session_key = $1 FOR UPDATE`,
        [input.sessionKey],
      );
      const existingSession = existingSessionResult.rows[0] ?? null;

      if (!existingSession && (!input.meeting || !input.session)) {
        return { status: "session-not-found" };
      }

      let finalMeetingKey: number | null;
      if (input.meeting && input.session) {
        await this.upsertMeetingWithClient(client, input.meeting);
        await this.upsertSessionWithClient(client, input.session);
        finalMeetingKey = input.session.meetingKey;
      } else {
        finalMeetingKey =
          existingSession.meetingKey === null ||
          existingSession.meetingKey === undefined
            ? null
            : Number(existingSession.meetingKey);
      }

      const finalQualifyingPart = input.hasQualifyingPart
        ? input.qualifyingPart
        : existingRecording.qualifyingPart === null ||
            existingRecording.qualifyingPart === undefined
          ? null
          : Number(existingRecording.qualifyingPart);

      const finalSessionName =
        input.session?.name ??
        existingSession?.name ??
        existingRecording.sessionName ??
        null;
      const finalSessionType =
        input.session?.type ??
        existingSession?.type ??
        existingRecording.sessionType ??
        null;

      const updated = await client.query(
        `UPDATE session_recordings AS sr
         SET session_key = $2,
             meeting_key = $3,
             session_name = $4,
             session_type = $5,
             qualifying_part = $6
         WHERE sr.session_id = $1
         RETURNING
           sr.session_id AS "sessionId",
           sr.filename,
           sr.session_name AS "sessionName",
           sr.session_type AS "sessionType",
           sr.meeting_key AS "meetingKey",
           sr.session_key AS "sessionKey",
           sr.qualifying_part AS "qualifyingPart",
           sr.source,
           sr.saved_at AS "savedAt",
           octet_length(sr.content) AS "sizeBytes"`,
        [
          sessionId,
          input.sessionKey,
          finalMeetingKey,
          finalSessionName,
          finalSessionType,
          finalQualifyingPart,
        ],
      );

      const sessionRow = await client.query(
        `${SESSION_SELECT} WHERE s.session_key = $1`,
        [input.sessionKey],
      );
      const meetingRow =
        finalMeetingKey === null
          ? null
          : await client.query(
              `${MEETING_SELECT} WHERE m.meeting_key = $1`,
              [finalMeetingKey],
            );

      return {
        status: "ok",
        recording: updated.rows[0],
        session: sessionRow.rows[0] ?? null,
        meeting: meetingRow?.rows[0] ?? null,
      };
    });
  }

  async deleteSession(
    sessionKey: number,
    options: { cascade: boolean },
  ): Promise<{
    status: "not-found" | "ok";
    session?: any;
    recordings?: any[];
  }> {
    return this.withTransaction(async (client) => {
      const lockResult = await client.query(
        `SELECT session_key FROM sessions WHERE session_key = $1 FOR UPDATE`,
        [sessionKey],
      );
      if (lockResult.rows.length === 0) return { status: "not-found" };

      const sessionResult = await client.query(
        `${SESSION_SELECT} WHERE s.session_key = $1`,
        [sessionKey],
      );
      const session = sessionResult.rows[0];
      if (!session) return { status: "not-found" };

      const recordingsResult = await client.query(
        `SELECT
           session_id AS "sessionId",
           filename,
           session_name AS "sessionName",
           session_type AS "sessionType",
           meeting_key AS "meetingKey",
           session_key AS "sessionKey",
           qualifying_part AS "qualifyingPart",
           source,
           saved_at AS "savedAt",
           octet_length(content) AS "sizeBytes"
         FROM session_recordings
         WHERE session_key = $1
         ORDER BY COALESCE(qualifying_part, 0) ASC, saved_at ASC`,
        [sessionKey],
      );

      if (options.cascade) {
        await client.query(
          `DELETE FROM session_recordings WHERE session_key = $1`,
          [sessionKey],
        );
      } else {
        await client.query(
          `UPDATE session_recordings
           SET session_key = NULL,
               meeting_key = NULL,
               session_name = COALESCE(session_name, $2),
               session_type = COALESCE(session_type, $3)
           WHERE session_key = $1`,
          [sessionKey, session.name, session.type],
        );
      }

      await client.query(`DELETE FROM sessions WHERE session_key = $1`, [
        sessionKey,
      ]);

      return {
        status: "ok",
        session,
        recordings: recordingsResult.rows,
      };
    });
  }

  async deleteMeeting(
    meetingKey: number,
    options: { cascade: boolean },
  ): Promise<{
    status: "not-found" | "ok";
    meeting?: any;
    sessions?: any[];
    recordings?: any[];
  }> {
    return this.withTransaction(async (client) => {
      const meetingLock = await client.query(
        `SELECT meeting_key FROM meetings WHERE meeting_key = $1 FOR UPDATE`,
        [meetingKey],
      );
      if (meetingLock.rows.length === 0) return { status: "not-found" };

      const sessionLocks = await client.query(
        `SELECT session_key FROM sessions WHERE meeting_key = $1 FOR UPDATE`,
        [meetingKey],
      );
      const sessionKeys = sessionLocks.rows.map((row: any) =>
        Number(row.session_key),
      );

      const meetingResult = await client.query(
        `${MEETING_SELECT} WHERE m.meeting_key = $1`,
        [meetingKey],
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) return { status: "not-found" };

      const sessionsResult = await client.query(
        `${SESSION_SELECT}
         WHERE s.meeting_key = $1
         ORDER BY s.start_date ASC NULLS LAST, s.session_key ASC`,
        [meetingKey],
      );

      const recordingsResult = await client.query(
        `SELECT
           session_id AS "sessionId",
           filename,
           session_name AS "sessionName",
           session_type AS "sessionType",
           meeting_key AS "meetingKey",
           session_key AS "sessionKey",
           qualifying_part AS "qualifyingPart",
           source,
           saved_at AS "savedAt",
           octet_length(content) AS "sizeBytes"
         FROM session_recordings
         WHERE meeting_key = $1 OR session_key = ANY($2::int[])
         ORDER BY session_key ASC NULLS LAST,
                  COALESCE(qualifying_part, 0) ASC,
                  saved_at ASC`,
        [meetingKey, sessionKeys],
      );

      if (options.cascade) {
        await client.query(
          `DELETE FROM session_recordings
           WHERE meeting_key = $1 OR session_key = ANY($2::int[])`,
          [meetingKey, sessionKeys],
        );
        await client.query(`DELETE FROM sessions WHERE meeting_key = $1`, [
          meetingKey,
        ]);
      } else {
        await client.query(
          `UPDATE session_recordings
           SET meeting_key = NULL
           WHERE meeting_key = $1 OR session_key = ANY($2::int[])`,
          [meetingKey, sessionKeys],
        );
        await client.query(
          `UPDATE sessions
           SET meeting_key = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE meeting_key = $1`,
          [meetingKey],
        );
      }

      await client.query(`DELETE FROM meetings WHERE meeting_key = $1`, [
        meetingKey,
      ]);

      return {
        status: "ok",
        meeting,
        sessions: sessionsResult.rows,
        recordings: recordingsResult.rows,
      };
    });
  }


  async findRecordingIdBySessionPart(
    sessionKey: number,
    qualifyingPart: number | null,
  ): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT session_id AS "sessionId"
       FROM session_recordings
       WHERE session_key = $1
         AND COALESCE(qualifying_part, 0) = COALESCE($2::int, 0)
       LIMIT 1`,
      [sessionKey, qualifyingPart],
    );
    return result.rows[0]?.sessionId ?? null;
  }

  async listMeetings(filters: MeetingFilters = {}): Promise<any[]> {
    const result = await this.pool.query(
      `${MEETING_SELECT}
       WHERE ($1::int IS NULL OR m.year = $1)
       ORDER BY m.year DESC, m.name ASC`,
      [filters.year ?? null],
    );
    return result.rows;
  }

  async getMeeting(meetingKey: number): Promise<any | null> {
    const result = await this.pool.query(
      `${MEETING_SELECT}
       WHERE m.meeting_key = $1`,
      [meetingKey],
    );
    return result.rows[0] ?? null;
  }

  async listSessions(filters: SessionFilters = {}): Promise<any[]> {
    const result = await this.pool.query(
      `${SESSION_SELECT}
       WHERE ($1::int IS NULL OR s.meeting_key = $1)
         AND ($2::int IS NULL OR m.year = $2)
         AND ($3::text IS NULL OR s.status = $3)
         AND ($4::boolean IS NULL OR (s.meeting_key IS NULL) = $4)
       ORDER BY s.start_date ASC NULLS LAST, s.session_key ASC`,
      [
        filters.meetingKey ?? null,
        filters.year ?? null,
        filters.status ?? null,
        filters.unassigned ?? null,
      ],
    );
    return result.rows;
  }

  async getSession(sessionKey: number): Promise<any | null> {
    const result = await this.pool.query(
      `${SESSION_SELECT}
       WHERE s.session_key = $1`,
      [sessionKey],
    );
    return result.rows[0] ?? null;
  }

  async getSessionDetails(
    sessionKey: number,
  ): Promise<{ session: any; recordings: any[] } | null> {
    const session = await this.getSession(sessionKey);
    if (!session) return null;

    const result = await this.pool.query(
      `SELECT
         session_id AS "sessionId",
         filename,
         qualifying_part AS "qualifyingPart",
         source,
         saved_at AS "savedAt",
         octet_length(content) AS "sizeBytes"
       FROM session_recordings
       WHERE session_key = $1
       ORDER BY COALESCE(qualifying_part, 0) ASC, saved_at ASC`,
      [sessionKey],
    );

    return {
      session,
      recordings: result.rows.map((row: any) => ({
        sessionId: row.sessionId,
        filename: row.filename,
        qualifyingPart: row.qualifyingPart ?? null,
        source: row.source,
        savedAt: toIsoDate(row.savedAt),
        sizeBytes: Number(row.sizeBytes),
      })),
    };
  }

  async getMeetingDetails(meetingKey: number): Promise<any | null> {
    const rows = await this.queryGroupedRows(meetingKey);
    const meetings = this.buildGroupedMeetings(rows);
    return meetings[0] ?? null;
  }

  async getGroupedRecordings(): Promise<{
    meetings: any[];
    standaloneSessions: any[];
    ungrouped: any[];
  }> {
    const rows = await this.queryGroupedRows(null, "completed");
    const meetings = this.buildGroupedMeetings(rows);
    const standaloneRows = await this.queryStandaloneRows("completed");
    const standaloneSessions = this.buildStandaloneSessions(standaloneRows);

    const ungroupedResult = await this.pool.query(
      `SELECT
         session_id AS "sessionId",
         filename,
         session_name AS "sessionName",
         session_type AS "sessionType",
         qualifying_part AS "qualifyingPart",
         source,
         saved_at AS "savedAt",
         octet_length(content) AS "sizeBytes"
       FROM session_recordings
       WHERE session_key IS NULL
       ORDER BY saved_at DESC, session_id ASC`,
    );

    return {
      meetings,
      standaloneSessions,
      ungrouped: ungroupedResult.rows.map((row: any) => ({
        sessionId: row.sessionId,
        filename: row.filename,
        sessionName: row.sessionName ?? null,
        sessionType: row.sessionType ?? null,
        qualifyingPart: row.qualifyingPart ?? null,
        source: row.source,
        savedAt: toIsoDate(row.savedAt),
        sizeBytes: Number(row.sizeBytes),
      })),
    };
  }

  private async queryStandaloneRows(
    sessionStatus: string | null = null,
  ): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT
         s.session_key AS "sessionKey",
         s.name AS "sessionName",
         s.type AS "sessionType",
         s.start_date AS "sessionStartDate",
         s.end_date AS "sessionEndDate",
         s.status AS "sessionStatus",
         r.session_id AS "recordingSessionId",
         r.qualifying_part AS "recordingQualifyingPart",
         r.source AS "recordingSource",
         r.saved_at AS "recordingSavedAt",
         octet_length(r.content) AS "recordingSizeBytes"
       FROM sessions s
       LEFT JOIN session_recordings r ON r.session_key = s.session_key
       WHERE s.meeting_key IS NULL
         AND ($1::text IS NULL OR s.status = $1)
       ORDER BY
         s.start_date ASC NULLS LAST,
         s.session_key ASC,
         COALESCE(r.qualifying_part, 0) ASC,
         r.saved_at ASC`,
      [sessionStatus],
    );
    return result.rows;
  }

  private buildStandaloneSessions(rows: any[]): any[] {
    const sessionsByKey = new Map<number, any>();

    for (const row of rows) {
      const sessionKey = Number(row.sessionKey);
      let session = sessionsByKey.get(sessionKey);
      if (!session) {
        session = {
          sessionKey,
          meetingKey: null,
          name: row.sessionName,
          type: row.sessionType,
          startDate: toIsoDate(row.sessionStartDate),
          endDate: toIsoDate(row.sessionEndDate),
          status: row.sessionStatus,
          hasRecording: false,
          recordings: [],
        };
        sessionsByKey.set(sessionKey, session);
      }

      if (row.recordingSessionId) {
        session.hasRecording = true;
        session.recordings.push({
          sessionId: row.recordingSessionId,
          qualifyingPart: row.recordingQualifyingPart ?? null,
          source: row.recordingSource,
          savedAt: toIsoDate(row.recordingSavedAt),
          sizeBytes: Number(row.recordingSizeBytes),
        });
      }
    }

    return Array.from(sessionsByKey.values());
  }

  private async queryGroupedRows(
    meetingKey: number | null,
    sessionStatus: string | null = null,
  ): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT
         m.meeting_key AS "meetingKey",
         m.name AS "meetingName",
         m.official_name AS "meetingOfficialName",
         m.location AS "meetingLocation",
         m.country_key AS "meetingCountryKey",
         m.country_code AS "meetingCountryCode",
         m.country_name AS "meetingCountryName",
         m.circuit_key AS "meetingCircuitKey",
         m.circuit_short_name AS "meetingCircuitShortName",
         m.year AS "meetingYear",
         s.session_key AS "sessionKey",
         s.name AS "sessionName",
         s.type AS "sessionType",
         s.start_date AS "sessionStartDate",
         s.end_date AS "sessionEndDate",
         s.status AS "sessionStatus",
         r.session_id AS "recordingSessionId",
         r.qualifying_part AS "recordingQualifyingPart",
         r.source AS "recordingSource",
         r.saved_at AS "recordingSavedAt",
         octet_length(r.content) AS "recordingSizeBytes"
       FROM meetings m
       LEFT JOIN sessions s
          ON s.meeting_key = m.meeting_key
         AND ($2::text IS NULL OR s.status = $2)
       LEFT JOIN session_recordings r ON r.session_key = s.session_key
       WHERE ($1::int IS NULL OR m.meeting_key = $1)
       ORDER BY
         m.year DESC,
         m.name ASC,
         s.start_date ASC NULLS LAST,
         s.session_key ASC,
         COALESCE(r.qualifying_part, 0) ASC,
         r.saved_at ASC`,
      [meetingKey, sessionStatus],
    );
    return result.rows;
  }

  private buildGroupedMeetings(rows: any[]): any[] {
    const meetingsByKey = new Map<number, any>();

    for (const row of rows) {
      const meetingKey = Number(row.meetingKey);
      let meeting = meetingsByKey.get(meetingKey);
      if (!meeting) {
        meeting = {
          meetingKey,
          name: row.meetingName,
          officialName: row.meetingOfficialName ?? null,
          location: row.meetingLocation ?? null,
          country: {
            key: row.meetingCountryKey ?? null,
            code: row.meetingCountryCode ?? null,
            name: row.meetingCountryName ?? null,
          },
          circuit: {
            key: row.meetingCircuitKey ?? null,
            shortName: row.meetingCircuitShortName ?? null,
          },
          year: Number(row.meetingYear),
          sessions: [],
        };
        meetingsByKey.set(meetingKey, meeting);
      }

      if (row.sessionKey === null || row.sessionKey === undefined) continue;

      const sessionKey = Number(row.sessionKey);
      let session = meeting.sessions.find(
        (item: any) => item.sessionKey === sessionKey,
      );
      if (!session) {
        session = {
          sessionKey,
          name: row.sessionName,
          type: row.sessionType,
          startDate: toIsoDate(row.sessionStartDate),
          endDate: toIsoDate(row.sessionEndDate),
          status: row.sessionStatus,
          hasRecording: false,
          recordings: [],
        };
        meeting.sessions.push(session);
      }

      if (row.recordingSessionId) {
        session.hasRecording = true;
        session.recordings.push({
          sessionId: row.recordingSessionId,
          qualifyingPart: row.recordingQualifyingPart ?? null,
          source: row.recordingSource,
          savedAt: toIsoDate(row.recordingSavedAt),
          sizeBytes: Number(row.recordingSizeBytes),
        });
      }
    }

    return Array.from(meetingsByKey.values());
  }

  getPool() {
    return this.pool;
  }
}
