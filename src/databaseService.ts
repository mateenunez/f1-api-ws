import { Pool } from "pg";
import bcrypt from "bcrypt";

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
        CREATE TABLE IF NOT EXISTS seasons (year INT PRIMARY KEY, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS grand_prix (id SERIAL PRIMARY KEY, season_year INT NOT NULL REFERENCES seasons(year) ON DELETE CASCADE, round_number INT NOT NULL, name VARCHAR(100) NOT NULL, circuit_key INT, circuit_short_name VARCHAR(50), country_name VARCHAR(50), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, CONSTRAINT unique_season_round UNIQUE(season_year, round_number));
        CREATE TABLE IF NOT EXISTS sessions (id SERIAL PRIMARY KEY, grand_prix_id INT NOT NULL REFERENCES grand_prix(id) ON DELETE CASCADE, session_name VARCHAR(50) NOT NULL, session_type VARCHAR(20) NOT NULL, date_start TIMESTAMP WITH TIME ZONE, date_end TIMESTAMP WITH TIME ZONE, status VARCHAR(20) DEFAULT 'SCHEDULED', created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, CONSTRAINT unique_gp_session UNIQUE(grand_prix_id, session_name));
        CREATE TABLE IF NOT EXISTS drivers (driver_number INT PRIMARY KEY, name_acronym VARCHAR(5) NOT NULL, full_name VARCHAR(100) NOT NULL, team_name VARCHAR(100), team_colour VARCHAR(10), headshot_url TEXT, is_active BOOLEAN DEFAULT TRUE, updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS predictions (id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, prediction_data JSONB NOT NULL, submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, points_earned INT DEFAULT 0, evaluated BOOLEAN DEFAULT FALSE, CONSTRAINT unique_user_session_prediction UNIQUE(user_id, session_id));
        CREATE TABLE IF NOT EXISTS session_results (session_id INT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, official_results JSONB NOT NULL, evaluated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS user_season_points (user_id INT REFERENCES users(id) ON DELETE CASCADE, season_year INT REFERENCES seasons(year) ON DELETE CASCADE, total_points INT DEFAULT 0, exact_hits INT DEFAULT 0, updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, season_year));
        ALTER TABLE user_season_points ADD COLUMN IF NOT EXISTS rank INT;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_status_valid') THEN
            ALTER TABLE sessions ADD CONSTRAINT sessions_status_valid CHECK (status IN ('SCHEDULED', 'OPEN', 'LOCKED', 'FINISHED', 'EVALUATED'));
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_type_valid') THEN
            ALTER TABLE sessions ADD CONSTRAINT sessions_type_valid CHECK (session_type IN ('FP', 'QUALIFYING', 'RACE', 'SPRINT'));
          END IF;
        END $$;
        CREATE INDEX IF NOT EXISTS idx_predictions_session ON predictions(session_id);
        CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_season_points_leaderboard ON user_season_points(season_year, total_points DESC, exact_hits DESC);
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

  getPool() {
    return this.pool;
  }
}
