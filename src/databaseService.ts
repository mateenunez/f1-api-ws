import { Pool } from "pg";
import bcrypt from "bcrypt";

export class DatabaseService {
  private pool: Pool;
  private readonly SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || "10");

  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      port: Number(process.env.POSTGRES_PORT),
    });
    this.initializeSchema();
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
