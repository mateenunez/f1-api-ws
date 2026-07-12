import { Pool } from "pg";

const DISCORD_INVITE_KEY = "discord_invite_url";

export class ConfigService {
  constructor(private pool: Pool) {}

  async getDiscordInviteUrl(): Promise<string | null> {
    const res = await this.pool.query(
      "SELECT value FROM app_config WHERE key = $1",
      [DISCORD_INVITE_KEY],
    );
    return res.rows[0]?.value ?? null;
  }

  async setDiscordInviteUrl(url: string): Promise<string> {
    await this.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [DISCORD_INVITE_KEY, url],
    );
    return url;
  }
}
