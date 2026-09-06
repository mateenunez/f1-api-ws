import { Pool } from "pg";

export class ProdeLockedError extends Error {
  constructor() { super("La votación para esta sesión ha cerrado"); this.name = "ProdeLockedError"; }
}

export class ProdeAlreadyVotedError extends Error {
  constructor() { super("Ya existe un voto para esta sesión"); this.name = "ProdeAlreadyVotedError"; }
}

const values = (value: any): any[] => Array.isArray(value) ? value : Object.values(value || {});

function driverEntries(driverList: Record<string, any>) {
  if (!driverList || typeof driverList !== "object" || Array.isArray(driverList)) return [];
  return Object.entries(driverList).map(([key, driver]: [string, any]) => ({
    number: Number(driver?.RacingNumber ?? driver?.DriverNumber ?? driver?.number ?? key),
    acronym: String(driver?.Tla ?? driver?.TLA ?? driver?.NameAcronym ?? "UNK"),
    fullName: String(driver?.FullName ?? driver?.BroadcastName ?? driver?.Name ?? "Unknown driver"),
    teamName: driver?.TeamName ?? driver?.Team ?? null,
    teamColour: driver?.TeamColour ?? driver?.TeamColor ?? null,
    headshotUrl: driver?.HeadshotUrl ?? driver?.HeadshotURL ?? null,
  })).filter((driver) => Number.isInteger(driver.number) && driver.number > 0 && driver.acronym !== "UNK");
}

function sessionType(name: string) {
  const value = name.toLowerCase();
  if (value.includes("qualifying") || value.includes("qualy")) return "QUALIFYING";
  if (value.includes("race") || value.includes("sprint")) return value.includes("sprint") ? "SPRINT" : "RACE";
  return "FP";
}

export class ProdeService {
  constructor(private pool: Pool) {}

  async syncDriversFromState(driverList: Record<string, any>) {
    const drivers = driverEntries(driverList);
    if (!drivers.length) return;
    await this.pool.query(`UPDATE drivers SET is_active = FALSE WHERE NOT (driver_number = ANY($1::int[]))`, [drivers.map((d) => d.number)]);
    await this.pool.query(`INSERT INTO drivers (driver_number, name_acronym, full_name, team_name, team_colour, headshot_url, is_active)
      SELECT *, TRUE FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
      ON CONFLICT (driver_number) DO UPDATE SET name_acronym = EXCLUDED.name_acronym, full_name = EXCLUDED.full_name, team_name = EXCLUDED.team_name, team_colour = EXCLUDED.team_colour, headshot_url = EXCLUDED.headshot_url, is_active = TRUE, updated_at = CURRENT_TIMESTAMP`,
      [drivers.map((d) => d.number), drivers.map((d) => d.acronym), drivers.map((d) => d.fullName), drivers.map((d) => d.teamName), drivers.map((d) => d.teamColour), drivers.map((d) => d.headshotUrl)]);
  }

  async syncSessionFromState(info: Record<string, any>) {
    const path = String(info.Path ?? "");
    const meeting = info.Meeting ?? info.meeting ?? {};
    const session = info.Session ?? info.session ?? info;
    const start = session.StartDate ?? session.StartTime ?? info.StartDate ?? info.StartTime;
    const end = session.EndDate ?? session.EndTime ?? info.EndDate ?? info.EndTime;
    const name = String(session.Name ?? session.NameEnglish ?? info.Name ?? info.NameEnglish ?? "Session");
    const year = Number(info.Year ?? meeting.Year ?? path.match(/(20\d{2})/)?.[1] ?? new Date(start || Date.now()).getUTCFullYear());
    const meetingKey = Number(meeting.Key ?? info.MeetingKey ?? 0);
    const round = Number(info.Round ?? meeting.Round ?? path.match(/\/(\d+)\//)?.[1] ?? meetingKey);
    if (!year || !round) return null;
    const gpName = String(meeting.Name ?? meeting.OfficialName ?? info.GrandPrixName ?? "Grand Prix");
    const circuit = String(meeting.Circuit?.ShortName ?? meeting.Location ?? info.Circuit?.ShortName ?? "");
    const circuitKey = Number(meeting.Circuit?.Key ?? info.Circuit?.Key ?? 0) || null;
    const country = typeof meeting.Country === "object" ? meeting.Country?.Name : meeting.Country ?? info.Country;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO seasons (year) VALUES ($1) ON CONFLICT (year) DO UPDATE SET is_active = TRUE`, [year]);
      const gp = await client.query(`INSERT INTO grand_prix (season_year, round_number, name, circuit_key, circuit_short_name, country_name) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (season_year, round_number) DO UPDATE SET name = EXCLUDED.name, circuit_key = EXCLUDED.circuit_key, circuit_short_name = EXCLUDED.circuit_short_name, country_name = EXCLUDED.country_name RETURNING id`, [year, round, gpName, circuitKey, circuit, country]);
      const gpId = gp.rows[0]?.id;
      if (!gpId) { await client.query("ROLLBACK"); return null; }
      const result = await client.query(`INSERT INTO sessions (grand_prix_id, session_name, session_type, date_start, date_end, status) VALUES ($1, $2, $3, $4, $5, 'OPEN')
      ON CONFLICT (grand_prix_id, session_name) DO UPDATE SET session_type = EXCLUDED.session_type, date_start = COALESCE(EXCLUDED.date_start, sessions.date_start), date_end = COALESCE(EXCLUDED.date_end, sessions.date_end), status = CASE WHEN sessions.status = 'SCHEDULED' THEN 'OPEN' ELSE sessions.status END RETURNING id`, [gpId, name, sessionType(name), start ? new Date(start) : null, end ? new Date(end) : null]);
      await client.query("COMMIT");
      return result.rows[0]?.id ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async lockSession(sessionId: number) { await this.pool.query(`UPDATE sessions SET status = 'LOCKED' WHERE id = $1 AND status NOT IN ('FINISHED', 'EVALUATED')`, [sessionId]); }

  async evaluateSession(sessionId: number, officialResults: Record<string, any>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lockedSession = await client.query(`SELECT s.status, s.session_type, gp.season_year FROM sessions s JOIN grand_prix gp ON gp.id = s.grand_prix_id WHERE s.id = $1 FOR UPDATE`, [sessionId]);
      if (!lockedSession.rows[0]) { await client.query("COMMIT"); return; }
      const sessionType = lockedSession.rows[0].session_type;
      const normalizedResults: Record<string, any> = { ...officialResults, podium: officialResults.podium ?? officialResults.top3 };
      if ((sessionType === "FP" || sessionType === "RACE" || sessionType === "SPRINT") && (!Array.isArray(normalizedResults.podium) || normalizedResults.podium.length < 3)) throw new Error("officialResults requiere podium/top3 completo");
      if (sessionType === "QUALIFYING" && (![normalizedResults.pole_driver, normalizedResults.fastest_lap_driver].every((driver) => Number.isInteger(Number(driver)) && Number(driver) > 0))) throw new Error("officialResults requiere pole_driver y fastest_lap_driver");
      await client.query(`INSERT INTO session_results (session_id, official_results) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET official_results = EXCLUDED.official_results, evaluated_at = CURRENT_TIMESTAMP`, [sessionId, normalizedResults]);
      await client.query(`UPDATE predictions SET points_earned = 0, evaluated = FALSE WHERE session_id = $1`, [sessionId]);
      await client.query(`WITH scores AS (
        SELECT p.id, p.user_id, gp.season_year,
          CASE WHEN ss.session_type = 'QUALIFYING' THEN
            (CASE WHEN p.prediction_data->>'pole_driver' = r.official_results->>'pole_driver' THEN 5 ELSE 0 END) +
            (CASE WHEN p.prediction_data->>'fastest_lap_driver' = r.official_results->>'fastest_lap_driver' THEN 5 ELSE 0 END)
          ELSE
            (SELECT COUNT(*) FILTER (WHERE predicted = official) * 5 + COUNT(*) FILTER (WHERE predicted <> official AND predicted = ANY(officials)) * 2 + CASE WHEN ss.session_type IN ('RACE', 'SPRINT') AND COUNT(*) FILTER (WHERE predicted = official) = 3 THEN 5 ELSE 0 END
             FROM generate_series(0, 2) AS positions(pos)
             CROSS JOIN LATERAL (SELECT
               (CASE WHEN ss.session_type = 'FP' THEN p.prediction_data->'top3' ELSE p.prediction_data->'podium' END)->>positions.pos AS predicted,
               r.official_results->'podium'->>positions.pos AS official,
               ARRAY(SELECT jsonb_array_elements_text(COALESCE(r.official_results->'podium', '[]'))) AS officials) comparison)
          END::int AS points,
          CASE WHEN ss.session_type = 'QUALIFYING' THEN
            (CASE WHEN p.prediction_data->>'pole_driver' = r.official_results->>'pole_driver' THEN 1 ELSE 0 END) + (CASE WHEN p.prediction_data->>'fastest_lap_driver' = r.official_results->>'fastest_lap_driver' THEN 1 ELSE 0 END)
          ELSE (SELECT COUNT(*) FROM generate_series(0, 2) AS positions(pos) WHERE (CASE WHEN ss.session_type = 'FP' THEN p.prediction_data->'top3' ELSE p.prediction_data->'podium' END)->>positions.pos = r.official_results->'podium'->>positions.pos) END::int AS hits
        FROM predictions p JOIN sessions ss ON ss.id = p.session_id JOIN grand_prix gp ON gp.id = ss.grand_prix_id JOIN session_results r ON r.session_id = p.session_id
        WHERE p.session_id = $1 AND NOT p.evaluated
      ) UPDATE predictions p SET points_earned = scores.points, evaluated = TRUE FROM scores WHERE p.id = scores.id`, [sessionId]);
      const seasonYear = lockedSession.rows[0].season_year;
      await client.query(`DELETE FROM user_season_points WHERE season_year = $1`, [seasonYear]);
      await client.query(`INSERT INTO user_season_points (user_id, season_year, total_points, exact_hits)
        SELECT p.user_id, gp.season_year, SUM(p.points_earned), SUM(
          CASE WHEN ss.session_type = 'QUALIFYING' THEN
            (CASE WHEN p.prediction_data->>'pole_driver' = r.official_results->>'pole_driver' THEN 1 ELSE 0 END) +
            (CASE WHEN p.prediction_data->>'fastest_lap_driver' = r.official_results->>'fastest_lap_driver' THEN 1 ELSE 0 END)
          ELSE (SELECT COUNT(*) FROM generate_series(0, 2) AS positions(pos)
            WHERE (CASE WHEN ss.session_type = 'FP' THEN p.prediction_data->'top3' ELSE p.prediction_data->'podium' END)->>positions.pos = r.official_results->'podium'->>positions.pos)
          END)
        FROM predictions p
        JOIN sessions ss ON ss.id = p.session_id
        JOIN grand_prix gp ON gp.id = ss.grand_prix_id
        JOIN session_results r ON r.session_id = p.session_id
        WHERE p.evaluated AND gp.season_year = $1
        GROUP BY p.user_id, gp.season_year`, [seasonYear]);
      await client.query(`UPDATE sessions SET status = 'EVALUATED' WHERE id = $1`, [sessionId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async getActiveProdeSession(userId?: number) {
    const testMode = process.env.PRODE_TEST_MODE === "true";
    const result = await this.pool.query(`SELECT s.*, gp.name AS grand_prix_name, gp.season_year, p.prediction_data AS my_prediction,
      CASE WHEN $2::boolean THEN 'OPEN' ELSE s.status END AS status,
      CASE WHEN $2::boolean THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes' ELSE s.date_start END AS date_start
      FROM sessions s JOIN grand_prix gp ON gp.id = s.grand_prix_id
      LEFT JOIN predictions p ON p.session_id = s.id AND p.user_id = $1
      WHERE s.status <> 'EVALUATED'
        AND ($2::boolean OR s.date_start IS NULL OR s.status = 'LOCKED' OR s.date_start > CURRENT_TIMESTAMP)
      ORDER BY s.date_start NULLS LAST LIMIT 1`, [userId ?? null, testMode]);
    return result.rows[0] ?? null;
  }

  async getCurrentGrandPrixId(sessionId?: number | null) {
    const result = await this.pool.query(`SELECT gp.id
      FROM grand_prix gp
      JOIN sessions s ON s.grand_prix_id = gp.id
      WHERE ($1::int IS NOT NULL AND s.id = $1)
        OR ($1::int IS NULL AND (s.status = 'EVALUATED'
        OR EXISTS (SELECT 1 FROM predictions p WHERE p.session_id = s.id)
        OR (s.date_start IS NOT NULL AND s.date_start <= CURRENT_TIMESTAMP))
      GROUP BY gp.id
      ORDER BY MAX(s.date_start) DESC
      LIMIT 1`, [sessionId ?? null]);
    return result.rows[0]?.id ?? null;
  }

  async getLeaderboardContext(sessionId?: number | null) {
    const result = await this.pool.query(`SELECT gp.id AS grand_prix_id, gp.season_year
      FROM sessions s
      JOIN grand_prix gp ON gp.id = s.grand_prix_id
      WHERE ($1::int IS NOT NULL AND s.id = $1)
        OR ($1::int IS NULL AND (
          s.status = 'EVALUATED'
          OR EXISTS (SELECT 1 FROM predictions p WHERE p.session_id = s.id)
          OR EXISTS (SELECT 1 FROM session_results r WHERE r.session_id = s.id)
        ))
      ORDER BY s.date_start DESC NULLS LAST, s.id DESC
      LIMIT 1`, [sessionId ?? null]);
    return result.rows[0] ?? null;
  }

  async getSeasonYearForSession(sessionId?: number | null) {
    if (!sessionId) return null;
    const result = await this.pool.query(`SELECT gp.season_year
      FROM sessions s JOIN grand_prix gp ON gp.id = s.grand_prix_id
      WHERE s.id = $1`, [sessionId]);
    return result.rows[0]?.season_year ?? null;
  }

  async getSeasonYearForGrandPrix(grandPrixId?: number | null) {
    if (!grandPrixId) return null;
    const result = await this.pool.query(`SELECT season_year FROM grand_prix WHERE id = $1`, [grandPrixId]);
    return result.rows[0]?.season_year ?? null;
  }

  async savePrediction(userId: number, sessionId: number, predictionData: Record<string, any>) {
    if (!predictionData || typeof predictionData !== "object" || Array.isArray(predictionData)) throw new Error("La predicción debe ser un objeto");
    const session = (await this.pool.query(`SELECT session_type, date_start, status FROM sessions WHERE id = $1`, [sessionId])).rows[0];
    const testMode = process.env.PRODE_TEST_MODE === "true";
    if (!session || (!testMode && (["LOCKED", "FINISHED", "EVALUATED"].includes(session.status) || (session.date_start && new Date(session.date_start).getTime() <= Date.now())))) throw new ProdeLockedError();
    const drivers = new Set((await this.pool.query(`SELECT driver_number FROM drivers WHERE is_active`)).rows.map((row) => Number(row.driver_number)));
    const list = session.session_type === "QUALIFYING" ? [predictionData.pole_driver, predictionData.fastest_lap_driver] : session.session_type === "FP" ? predictionData.top3 : predictionData.podium;
    if (!Array.isArray(list)) throw new Error("La predicción debe contener una lista de pilotos");
    const expectedLength = session.session_type === "QUALIFYING" ? 2 : 3;
    const selected = list;
    if (selected.length !== expectedLength) throw new Error("La predicción no contiene todas las posiciones requeridas");
    const driverNumbers = selected.map((driver: any) => Number(driver));
    if (!driverNumbers.every((driver: number) => Number.isInteger(driver) && drivers.has(driver)) || new Set(driverNumbers).size !== driverNumbers.length) throw new Error("La predicción contiene pilotos inválidos o repetidos");
    const result = await this.pool.query(`INSERT INTO predictions (user_id, session_id, prediction_data) SELECT $1, id, $3 FROM sessions WHERE id = $2 AND ($4::boolean OR (status NOT IN ('LOCKED', 'FINISHED', 'EVALUATED') AND (date_start IS NULL OR date_start > CURRENT_TIMESTAMP))) ON CONFLICT (user_id, session_id) DO NOTHING RETURNING *`, [userId, sessionId, predictionData, testMode]);
    if (!result.rowCount) {
      const existing = await this.pool.query(`SELECT 1 FROM predictions WHERE user_id = $1 AND session_id = $2`, [userId, sessionId]);
      if (existing.rowCount) throw new ProdeAlreadyVotedError();
      throw new ProdeLockedError();
    }
    return result.rows[0];
  }

  async getHistory(userId: number) { return (await this.pool.query(`SELECT p.*, s.session_name, gp.name AS grand_prix_name FROM predictions p JOIN sessions s ON s.id = p.session_id JOIN grand_prix gp ON gp.id = s.grand_prix_id WHERE p.user_id = $1 ORDER BY p.submitted_at DESC`, [userId])).rows; }
  async getDrivers() { return (await this.pool.query(`SELECT * FROM drivers WHERE is_active ORDER BY driver_number`)).rows; }
  async getSeasonLeaderboard(year: number, search = "", userId?: number, page = 1, pageSize = 25) {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const offset = (safePage - 1) * safePageSize;
    const rankedQuery = `WITH ranked AS (
      SELECT totals.user_id, u.username, totals.total_points, totals.exact_hits,
        ROW_NUMBER() OVER (ORDER BY totals.total_points DESC, totals.exact_hits DESC, u.username)::int AS rank
      FROM (
        SELECT p.user_id, SUM(p.points_earned)::int AS total_points,
          COUNT(*) FILTER (WHERE p.points_earned > 0)::int AS exact_hits
        FROM predictions p
        JOIN sessions s ON s.id = p.session_id
        JOIN grand_prix gp ON gp.id = s.grand_prix_id
        WHERE gp.season_year = $1 AND p.evaluated = TRUE
        GROUP BY p.user_id
      ) totals
      JOIN users u ON u.id = totals.user_id
    ), filtered AS (
      SELECT ranked.*, ranked.user_id = $3 AS is_current_user
      FROM ranked
      WHERE ($2 = '' OR ranked.username ILIKE '%' || $2 || '%') OR ranked.user_id = $3
    )
    SELECT filtered.*, COUNT(*) OVER()::int AS total_count
    FROM filtered ORDER BY filtered.rank LIMIT $4 OFFSET $5`;
    const currentQuery = `WITH ranked AS (${rankedQuery.slice(rankedQuery.indexOf("SELECT totals"), rankedQuery.indexOf("), filtered AS"))}) SELECT ranked.*, TRUE AS is_current_user FROM ranked WHERE ranked.user_id = $2`;
    const [result, currentResult] = await Promise.all([
      this.pool.query(rankedQuery, [year, search, userId ?? null, safePageSize, offset]),
      this.pool.query(currentQuery, [year, userId ?? null]),
    ]);
    const total = result.rows[0]?.total_count ?? 0;
    return { rows: result.rows.map(({ total_count, ...row }) => row), currentUser: currentResult.rows[0] ?? null, pagination: { page: safePage, pageSize: safePageSize, total, totalPages: Math.ceil(total / safePageSize) } };
  }
  async getGpLeaderboard(id: number, search = "", userId?: number, page = 1, pageSize = 25) {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const offset = (safePage - 1) * safePageSize;
    const rankedQuery = `WITH ranked AS (
      SELECT p.user_id, u.username, SUM(p.points_earned)::int AS total_points,
        COUNT(*) FILTER (WHERE p.points_earned > 0)::int AS exact_hits,
        ROW_NUMBER() OVER (ORDER BY SUM(p.points_earned) DESC, COUNT(*) FILTER (WHERE p.points_earned > 0) DESC, u.username)::int AS rank
      FROM predictions p JOIN users u ON u.id = p.user_id
      WHERE p.session_id IN (SELECT id FROM sessions WHERE grand_prix_id = $1)
      GROUP BY p.user_id, u.username
    ), filtered AS (
      SELECT ranked.*, ranked.user_id = $3 AS is_current_user
      FROM ranked
      WHERE ($2 = '' OR ranked.username ILIKE '%' || $2 || '%') OR ranked.user_id = $3
    )
    SELECT filtered.*, COUNT(*) OVER()::int AS total_count
    FROM filtered ORDER BY filtered.rank LIMIT $4 OFFSET $5`;
    const currentQuery = `WITH ranked AS (
      SELECT p.user_id, u.username, SUM(p.points_earned)::int AS total_points,
        COUNT(*) FILTER (WHERE p.points_earned > 0)::int AS exact_hits,
        ROW_NUMBER() OVER (ORDER BY SUM(p.points_earned) DESC, COUNT(*) FILTER (WHERE p.points_earned > 0) DESC, u.username)::int AS rank
      FROM predictions p JOIN users u ON u.id = p.user_id
      WHERE p.session_id IN (SELECT id FROM sessions WHERE grand_prix_id = $1)
      GROUP BY p.user_id, u.username
    ) SELECT ranked.*, TRUE AS is_current_user FROM ranked WHERE ranked.user_id = $2`;
    const [result, currentResult] = await Promise.all([
      this.pool.query(rankedQuery, [id, search, userId ?? null, safePageSize, offset]),
      this.pool.query(currentQuery, [id, userId ?? null]),
    ]);
    const total = result.rows[0]?.total_count ?? 0;
    return { rows: result.rows.map(({ total_count, ...row }) => row), currentUser: currentResult.rows[0] ?? null, pagination: { page: safePage, pageSize: safePageSize, total, totalPages: Math.ceil(total / safePageSize) } };
  }
  async getInfo() { return { scoring: { practice: { exact: 5, partial: 2 }, qualifying: { pole: 5, fastestLap: 5 }, race: { exact: 5, partial: 2, podiumBonus: 5 } }, voting: { opens: "when_session_is_created", prominentAtMinutes: 60, closesAt: "telemetry_started" } }; }

  async getAdminSeasons() {
    return (await this.pool.query(`SELECT s.*, COUNT(DISTINCT gp.id)::int AS grand_prix_count
      FROM seasons s LEFT JOIN grand_prix gp ON gp.season_year = s.year
      GROUP BY s.year ORDER BY s.year DESC`)).rows;
  }

  async getAdminGrandPrix(year?: number) {
    return (await this.pool.query(`SELECT gp.*, COUNT(s.id)::int AS session_count
      FROM grand_prix gp LEFT JOIN sessions s ON s.grand_prix_id = gp.id
      WHERE ($1::int IS NULL OR gp.season_year = $1)
      GROUP BY gp.id ORDER BY gp.season_year DESC, gp.round_number`, [year ?? null])).rows;
  }

  async getAdminSessions(grandPrixId?: number, year?: number) {
    return (await this.pool.query(`SELECT s.*, gp.name AS grand_prix_name, gp.season_year, gp.round_number,
      COUNT(p.id)::int AS prediction_count
      FROM sessions s JOIN grand_prix gp ON gp.id = s.grand_prix_id
      LEFT JOIN predictions p ON p.session_id = s.id
      WHERE ($1::int IS NULL OR s.grand_prix_id = $1)
        AND ($2::int IS NULL OR gp.season_year = $2)
      GROUP BY s.id, gp.name, gp.season_year, gp.round_number
      ORDER BY gp.season_year DESC, gp.round_number, s.date_start NULLS LAST`, [grandPrixId ?? null, year ?? null])).rows;
  }

  async updateAdminSession(sessionId: number, changes: { sessionName?: string; sessionType?: string; dateStart?: string | null; dateEnd?: string | null; status?: string }) {
    const fields: string[] = [];
    const parameters: any[] = [];
    const add = (column: string, value: any) => { fields.push(`${column} = $${parameters.length + 1}`); parameters.push(value); };
    if (changes.sessionName !== undefined) add("session_name", changes.sessionName);
    if (changes.sessionType !== undefined) add("session_type", changes.sessionType);
    if (changes.dateStart !== undefined) add("date_start", changes.dateStart);
    if (changes.dateEnd !== undefined) add("date_end", changes.dateEnd);
    if (changes.status !== undefined) add("status", changes.status);
    if (!fields.length) throw new Error("At least one session field is required");
    parameters.push(sessionId);
    const result = await this.pool.query(`UPDATE sessions SET ${fields.join(", ")} WHERE id = $${parameters.length} RETURNING *`, parameters);
    if (!result.rowCount) throw new Error("Session not found");
    return result.rows[0];
  }

  async getAdminPredictions(sessionId: number) {
    return (await this.pool.query(`SELECT p.*, u.username, u.email
      FROM predictions p JOIN users u ON u.id = p.user_id
      WHERE p.session_id = $1 ORDER BY p.submitted_at DESC`, [sessionId])).rows;
  }

  async getSessionResult(sessionId: number) {
    return (await this.pool.query(`SELECT * FROM session_results WHERE session_id = $1`, [sessionId])).rows[0] ?? null;
  }

  async saveSessionResult(sessionId: number, officialResults: Record<string, any>) {
    const result = await this.pool.query(`INSERT INTO session_results (session_id, official_results)
      VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET official_results = EXCLUDED.official_results,
      evaluated_at = CURRENT_TIMESTAMP RETURNING *`, [sessionId, officialResults]);
    return result.rows[0];
  }

  async deletePrediction(predictionId: number) {
    const result = await this.pool.query(`DELETE FROM predictions WHERE id = $1 RETURNING id`, [predictionId]);
    if (!result.rowCount) throw new Error("Prediction not found");
    return result.rows[0];
  }

  async getAdminDrivers() {
    return (await this.pool.query(`SELECT * FROM drivers ORDER BY is_active DESC, driver_number`)).rows;
  }

  async updateAdminDriver(driverNumber: number, changes: { nameAcronym?: string; fullName?: string; teamName?: string | null; teamColour?: string | null; headshotUrl?: string | null; isActive?: boolean }) {
    const fields: string[] = [];
    const parameters: any[] = [];
    const add = (column: string, value: any) => { fields.push(`${column} = $${parameters.length + 1}`); parameters.push(value); };
    if (changes.nameAcronym !== undefined) add("name_acronym", changes.nameAcronym);
    if (changes.fullName !== undefined) add("full_name", changes.fullName);
    if (changes.teamName !== undefined) add("team_name", changes.teamName);
    if (changes.teamColour !== undefined) add("team_colour", changes.teamColour);
    if (changes.headshotUrl !== undefined) add("headshot_url", changes.headshotUrl);
    if (changes.isActive !== undefined) add("is_active", changes.isActive);
    if (!fields.length) throw new Error("At least one driver field is required");
    fields.push("updated_at = CURRENT_TIMESTAMP");
    parameters.push(driverNumber);
    const result = await this.pool.query(`UPDATE drivers SET ${fields.join(", ")} WHERE driver_number = $${parameters.length} RETURNING *`, parameters);
    if (!result.rowCount) throw new Error("Driver not found");
    return result.rows[0];
  }
}