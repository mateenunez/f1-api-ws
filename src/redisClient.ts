import Redis, { Redis as RedisType } from "ioredis";

class RedisClient {
  private client: RedisType;
  private silent = false;

  constructor() {
    const REDIS_HOST = process.env.REDISHOST || "localhost";
    const REDIS_PORT = process.env.REDISPORT
      ? parseInt(process.env.REDISPORT, 10)
      : 6379;
    const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

    this.client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      password: REDIS_PASSWORD,
      maxRetriesPerRequest: 3,
    });

    this.client.on("connect", () => {
      console.log(`Redis connection succeeded on ${REDIS_HOST}:${REDIS_PORT}`);
      this.silent = false;
    });
    this.client.on("error", (err: any) => {
      if (!this.silent) {
        console.error("Redis error:", err);
        this.silent = true;
      }
    });
  }

  private makeKey(
    sessionId: string,
    feedName: string,
    timestamp: string | number
  ) {
    return `${sessionId}:${feedName}:${timestamp}`;
  }

  private removeMiliseconds(ts: string | number): string {
    return String(ts).split(".")[0];
  }

  async save(
    sessionId: string,
    feedName: string,
    timestamp: string | number,
    text: string
  ): Promise<void> {
    const key = this.makeKey(
      sessionId,
      feedName,
      feedName === "TeamRadio" ? timestamp : this.removeMiliseconds(timestamp)
    );
    try {
      await this.client.set(key, text);
    } catch (err) {
      console.error("Error at save one text:", err);
      throw err;
    }
  }

  async get(
    sessionId: string,
    feedName: string,
    timestamp: string | number
  ): Promise<string | null> {
    const key = this.makeKey(sessionId, feedName, timestamp);
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error("Error at get one text:", err);
      throw err;
    }
  }

  async getList<T extends { timestamp: string | number }>(
    sessionId: string,
    feedName: string,
    items: T[]
  ): Promise<Array<any>> {
    if (!items || items.length === 0) return [];

    const keys = items.map((it) =>
      this.makeKey(sessionId, feedName, it.timestamp)
    );
    try {
      const values = await this.client.mget(...keys);
      return items.map((it, idx) => {
        const raw = values[idx];
        if (!raw) return null;
        return JSON.parse(raw);
      });
    } catch (err) {
      console.error("Error at get list of texts:", err);
      return [];
    }
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}

export { RedisClient };
