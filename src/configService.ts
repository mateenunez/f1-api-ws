import { Pool } from "pg";

const DISCORD_INVITE_KEY = "discord_invite_url";
const FUNDING_COST_KEY = "funding_cost_usd";
const FUNDING_DONATED_KEY = "funding_donated_usd";

export interface FundingStatus {
  costUsd: number;
  donatedUsd: number;
}

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

  async getFundingStatus(): Promise<FundingStatus> {
    const res = await this.pool.query(
      "SELECT key, value FROM app_config WHERE key = ANY($1)",
      [[FUNDING_COST_KEY, FUNDING_DONATED_KEY]],
    );
    const byKey = Object.fromEntries(res.rows.map((r) => [r.key, r.value]));
    return {
      costUsd: Number(byKey[FUNDING_COST_KEY] ?? 0),
      donatedUsd: Number(byKey[FUNDING_DONATED_KEY] ?? 0),
    };
  }

  async setFundingCost(costUsd: number): Promise<number> {
    await this.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [FUNDING_COST_KEY, String(costUsd)],
    );
    return costUsd;
  }

  async setFundingDonated(donatedUsd: number): Promise<number> {
    await this.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [FUNDING_DONATED_KEY, String(donatedUsd)],
    );
    return donatedUsd;
  }
}
