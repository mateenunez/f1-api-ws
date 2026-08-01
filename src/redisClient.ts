import Redis, { Redis as RedisType } from "ioredis";


class RedisClient {
  private client: RedisType;
  private silent = false;

  constructor() {
    const REDIS_HOST = process.env.REDIS_HOST;
    const REDIS_PORT = process.env.REDIS_PORT
      ? parseInt(process.env.REDIS_PORT, 10)
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

  private makeKey(sessionId: string, feedName: string, objectKey: string) {
    return `${sessionId}:${feedName}:${objectKey}`;
  }

  async save(
    sessionId: string,
    feedName: string,
    objectKey: string,
    objectValue: string,
  ): Promise<void> {
    const key = this.makeKey(sessionId, feedName, objectKey);
    try {
      await this.client.set(key, objectValue);
    } catch (err) {
      console.error("Error saving object on Redis:", err);
      throw err;
    }
  }

  async get(
    sessionId: string,
    feedName: string,
    objectKey: string,
  ): Promise<string | null> {
    const key = this.makeKey(sessionId, feedName, objectKey);
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error("Error at get one text:", err);
      throw err;
    }
  }

  async getList(
    sessionId: string,
    feedName: string,
    items: any[],
  ): Promise<Array<any>> {
    if (
      !items ||
      typeof items !== "object" ||
      Object.keys(items).length === 0
    ) {
      return [];
    }

    const objectKeys = Object.keys(items);
    const keys = objectKeys.map((objKey) =>
      this.makeKey(sessionId, feedName, objKey),
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

  // Fixed-window counter: first call in the window sets the TTL, every call
  // in-window just increments. Used for rate limiting (e.g. password-reset
  // request caps) rather than the telemetry save/get above.
  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, ttlSeconds);
      }
      return count;
    } catch (err) {
      console.error("Error incrementing rate-limit counter:", err);
      throw err;
    }
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}

export { RedisClient };
