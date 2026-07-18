import { RedisClient } from "./redisClient";

interface FullState {
  R: any;
}

interface StateProvider {
  getState(): FullState;
}

interface ClockAnchor {
  remainingMs: number;
  extrapolating: boolean;
  receivedAt: number;
}

class StateProcessor implements StateProvider {
  fullState: FullState;

  // Anchors the last real ExtrapolatedClock tick to the server's own receipt
  // time, so getState() can re-derive "remaining right now" for a client
  // connecting mid-session instead of handing out a stale Remaining value.
  private clockAnchor: ClockAnchor | null = null;

  constructor(private redis: RedisClient) {
    this.fullState = {
      R: {},
    };
  }

  private parseRemaining(remaining: string): number | null {
    if (typeof remaining !== "string") return null;
    const parts = remaining.split(":").map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    const [hours, minutes, seconds] = parts;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  private formatRemaining(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const pad = (n: number) => n.toString().padStart(2, "0");
    return [
      Math.floor(totalSeconds / 3600),
      Math.floor((totalSeconds % 3600) / 60),
      totalSeconds % 60,
    ]
      .map(pad)
      .join(":");
  }

  // Re-syncs the anchor from whatever the feed just gave us. F1 only pushes
  // this feed on state changes (extrapolating on/off, red flag, etc.), not
  // once a second, so this anchor is what lets us reconstruct "remaining
  // now" long after the last actual update.
  private syncClockAnchor() {
    const clock = this.fullState.R?.ExtrapolatedClock;
    if (!clock) return;

    const remainingMs = this.parseRemaining(clock.Remaining);
    if (remainingMs === null) return;

    this.clockAnchor = {
      remainingMs,
      extrapolating: !!clock.Extrapolating,
      receivedAt: Date.now(),
    };
  }

  // deepMerge only ever adds/overwrites keys, it never drops stale ones, so
  // RaceControlMessages/TeamRadio would otherwise keep accumulating across
  // an entire race weekend (they're only wiped wholesale when the bridge
  // connection resets on SessionStatus "Inactive", which doesn't fire
  // between e.g. FP1 -> FP2 -> Quali -> Race). Clear them explicitly the
  // moment SessionInfo.Path shows we've moved to a new session, so a client
  // connecting mid-session doesn't see messages/radios left over from the
  // previous one.
  private resetPerSessionFeeds() {
    console.log("New session detected, clearing race control and team radio state.");
    this.fullState.R.RaceControlMessages = { Messages: {} };
    this.fullState.R.RaceControlMessagesEs = { Messages: {} };
    this.fullState.R.TeamRadio = { Captures: {} };
  }

  getState() {
    if (!this.clockAnchor || !this.fullState.R?.ExtrapolatedClock) {
      return this.fullState;
    }

    const { remainingMs, extrapolating, receivedAt } = this.clockAnchor;
    const liveMs = extrapolating
      ? Math.max(0, remainingMs - (Date.now() - receivedAt))
      : remainingMs;

    return {
      ...this.fullState,
      R: {
        ...this.fullState.R,
        ExtrapolatedClock: {
          ...this.fullState.R.ExtrapolatedClock,
          Remaining: this.formatRemaining(liveMs),
        },
      },
    };
  }

  getPath() {
    return this.fullState.R?.SessionInfo?.Path ?? "";
  }

  getSessionId() {
    return this.fullState.R?.SessionInfo?.Meeting?.Key ?? "";
  }

  async saveToRedis(feedName: string, data: any): Promise<void> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) {
        console.error("No session ID at saveToRedis");
        return;
      }

      const serializedData = JSON.stringify(data.msg || data.cap);
      const objectKey = data.key;
      await this.redis.save(sessionId, feedName, objectKey, serializedData);
    } catch (err) {
      console.error(`Error saving ${feedName} to Redis:`, err);
    }
  }

  async getListFromRedis(
    feedName: string,
  ): Promise<Array<{ text: string | null }>> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) return [];

      let items = [];

      if (feedName === "TeamRadio") {
        items = this.fullState?.R?.TeamRadio?.Captures || [];
      } else if (feedName === "RaceControlMessagesEs") {
        items = this.fullState?.R?.RaceControlMessages?.Messages || [];
      }

      if (!items || items.length === 0) return [];

      return (await this.redis.getList(sessionId, feedName, items)).filter(
        (it) => it !== null,
      );
    } catch (err) {
      console.log(`Error fetching ${feedName} from Redis:`, err);
      return [];
    }
  }

  async updateRedis() {
    const Messages = await this.getListFromRedis("RaceControlMessagesEs");
    this.fullState.R.RaceControlMessagesEs = { Messages: Messages };
    const redisCaptures = await this.getListFromRedis("TeamRadio");
    const existingCaptures = this.fullState.R.TeamRadio?.Captures || [];
    const mergedCaptures = existingCaptures.map((capture: any) => {
      const redisCapture = redisCaptures.find(
        (redisCapture: any) => capture.Utc === redisCapture.Utc,
      );
      if (redisCapture) return redisCapture;
      else return capture;
    });
    this.fullState.R.TeamRadio = { Captures: mergedCaptures };
  }

  async updateState(newState: FullState) {
    this.fullState = newState;
    this.syncClockAnchor();
    await this.updateRedis();
  }

  async updateStatePremium(newState: FullState) {
    this.fullState.R = newState;
    this.syncClockAnchor();
    await this.updateRedis();
  }

  updatePartialState(path: string, data: any) {
    this.deepMerge(this.fullState.R, { [path]: data });
  }

  deepMerge(target: any, source: any) {
    for (const key in source) {
      if (Array.isArray(source[key])) {
        console.log("Array replaced at key:", key);
        target[key] = source[key];
      } else if (source[key] instanceof Object && source[key] !== null) {
        if (!target[key] || typeof target[key] !== "object") {
          target[key] = {};
        }
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }


  processFeed(feedName: string, data: any, timestamp: string) {
    if (!this.fullState.R) {
      return;
    }

    switch (feedName) {
      case "Heartbeat":
        if (this.fullState?.R?.Heartbeat) {
          this.deepMerge(this.fullState.R.Heartbeat, data);
        }
        break;

      case "CarData.z":
        if (this.fullState?.R?.CarData) {
          this.deepMerge(this.fullState.R.CarData, data);
        }
        break;

      case "Position.z":
        if (this.fullState?.R?.Position) {
          this.deepMerge(this.fullState.R.Position, data);
        }
        break;

      case "TimingData":
        if (this.fullState?.R?.TimingData) {
          this.deepMerge(this.fullState.R.TimingData, data);
        }
        break;

      case "TimingStats":
        if (this.fullState?.R?.TimingStats) {
          this.deepMerge(this.fullState.R.TimingStats, data);
        }
        break;

      case "TimingAppData":
        if (this.fullState?.R?.TimingAppData) {
          this.deepMerge(this.fullState.R.TimingAppData, data);
        }
        break;

      case "WeatherData":
        if (this.fullState?.R?.WeatherData) {
          this.deepMerge(this.fullState.R.WeatherData, data);
        }
        break;

      case "TrackStatus":
        if (this.fullState?.R?.TrackStatus) {
          this.deepMerge(this.fullState.R.TrackStatus, data);
        }
        break;

      case "DriverList":
        if (this.fullState?.R?.DriverList) {
          this.deepMerge(this.fullState.R.DriverList, data);
        }
        break;

      case "RaceControlMessages":
        if (this.fullState?.R?.RaceControlMessages) {
          this.deepMerge(this.fullState.R.RaceControlMessages, data);
        }
        break;

      case "RaceControlMessagesEs":
        if (this.fullState?.R?.RaceControlMessagesEs) {
          this.deepMerge(this.fullState.R.RaceControlMessagesEs, data);
        }
        break;

      case "SessionInfo": {
        if (this.fullState?.R?.SessionInfo) {
          const previousPath = this.fullState.R.SessionInfo?.Path;
          this.deepMerge(this.fullState.R.SessionInfo, data);

          if (
            typeof data?.Path === "string" &&
            data.Path &&
            previousPath &&
            data.Path !== previousPath
          ) {
            this.resetPerSessionFeeds();
          }
        }
        break;
      }

      case "SessionData":
        if (this.fullState?.R?.SessionData) {
          this.deepMerge(this.fullState.R.SessionData, data);
        }
        break;

      case "ExtrapolatedClock":
        if (this.fullState?.R?.ExtrapolatedClock) {
          this.deepMerge(this.fullState.R.ExtrapolatedClock, data);
          this.syncClockAnchor();
        }
        break;

      case "TyreStintSeries":
        if (this.fullState?.R?.TyreStintSeries) {
          this.deepMerge(this.fullState.R.TyreStintSeries, data);
        }
        break;

      case "TeamRadio":
        if (this.fullState?.R?.TeamRadio) {
          this.deepMerge(this.fullState.R.TeamRadio, data);
        }
        break;

      case "TopThree":
        if (this.fullState?.R?.TopThree) {
          this.deepMerge(this.fullState.R.TopThree, data);
        }
        break;

      case "LapCount":
        if (this.fullState?.R?.LapCount) {
          this.deepMerge(this.fullState.R.LapCount, data);
        }
        break;

      default:
        console.warn(`Feed "${feedName}" not recognized.`);
    }
  }
}

export { StateProcessor, StateProvider };
