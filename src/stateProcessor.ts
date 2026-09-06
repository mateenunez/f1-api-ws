import { RedisClient } from "./redisClient";
import { ProdeService } from "./prodeService";

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
  private prodeSessionId: number | null = null;
  private evaluatedProdeSessionId: number | null = null;
  private evaluatingProdeSessionId: number | null = null;
  private pendingProdeStatus: any | null = null;

  constructor(private redis: RedisClient, private prodeService?: ProdeService) {
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
    await this.syncProdeState();
  }

  async updateStatePremium(newState: FullState) {
    this.fullState.R = newState;
    this.syncClockAnchor();
    await this.updateRedis();
    await this.syncProdeState();
  }

  private async syncProdeState() {
    if (!this.prodeService) return;

    const driverList = this.fullState.R?.DriverList;
    if (driverList && typeof driverList === "object") {
      try {
        await this.prodeService.syncDriversFromState(driverList);
      } catch (error) {
        console.error("Prode driver sync failed:", error);
      }
    }

    const sessionInfo = this.fullState.R?.SessionInfo;
    if (sessionInfo && typeof sessionInfo === "object") {
      try {
        const sessionId = await this.prodeService.syncSessionFromState(sessionInfo);
        if (sessionId) {
          this.prodeSessionId = sessionId;
          this.handleProdeSessionStatus(sessionInfo);
        }
      } catch (error) {
        console.error("Prode session sync failed:", error);
      }
    }
  }

  updatePartialState(path: string, data: any) {
    this.deepMerge(this.fullState.R, { [path]: data });
  }

  getProdeSessionId() {
    return this.prodeSessionId;
  }

  getProdeOfficialResults() {
    const driverNumber = (line: any, key?: string) => {
      const value = Number(line?.RacingNumber ?? line?.Number ?? line?.driver_number ?? key);
      return Number.isInteger(value) && value > 0 ? value : undefined;
    };
    const lineSources = [
      this.fullState.R?.TopThree?.Lines,
      this.fullState.R?.TimingData?.Lines,
      this.fullState.R?.TimingData?.lines,
    ];
    const source = lineSources.find((value) => value && Object.keys(value).length > 0) ?? {};
    const lines = Object.entries(source).sort(([leftKey, left], [rightKey, right]) =>
      Number((left as any)?.Position ?? (left as any)?.position ?? leftKey) -
      Number((right as any)?.Position ?? (right as any)?.position ?? rightKey),
    );
    const drivers = lines
      .slice(0, 3)
      .map(([key, line]: [string, any]) => driverNumber(line, key))
      .filter((driver): driver is number => driver !== undefined);
    const lapSeconds = (value: any): number | undefined => {
      const text = typeof value === "object" ? value?.Value : value;
      if (typeof text !== "string") return undefined;
      const parts = text.split(":").map(Number);
      if (parts.some((part) => !Number.isFinite(part))) return undefined;
      return parts.length === 2 ? parts[0] * 60 + parts[1] : parts.length === 1 ? parts[0] : undefined;
    };
    const fastest = lines
      .map(([key, line]) => ({
        key,
        line,
        time: lapSeconds((line as any)?.BestLapTime) ??
          lapSeconds((line as any)?.FastestLapTime) ??
          lapSeconds((line as any)?.PersonalBestLapTime),
      }))
      .filter((entry): entry is typeof entry & { time: number } => entry.time !== undefined)
      .sort((left, right) => left.time - right.time)[0];
    const fastestDriver = fastest ? driverNumber(fastest.line, fastest.key) : drivers[0];

    return {
      podium: drivers,
      top3: drivers,
      pole_driver: drivers[0],
      fastest_lap_driver: fastestDriver,
    };
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
          this.handleProdeSessionStatus(data);
        }
        break;

      case "DriverList":
        this.deepMerge(this.fullState.R, { DriverList: data });
        void this.prodeService?.syncDriversFromState(this.fullState.R.DriverList).catch((error) => console.error("Prode driver sync failed:", error));
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
        const previousPath = this.fullState.R.SessionInfo?.Path;
        this.deepMerge(this.fullState.R, { SessionInfo: data });
        void this.prodeService?.syncSessionFromState(this.fullState.R.SessionInfo).then((id) => {
          if (id) {
            this.prodeSessionId = id;
            this.handleProdeSessionStatus(this.pendingProdeStatus ?? this.fullState.R.SessionInfo);
            this.pendingProdeStatus = null;
          }
        }).catch((error) => console.error("Prode session sync failed:", error));

        if (
          typeof data?.Path === "string" &&
          data.Path &&
          previousPath &&
          data.Path !== previousPath
        ) {
          this.resetPerSessionFeeds();
        }
        break;
      }

      case "SessionData":
        if (this.fullState?.R?.SessionData) {
          this.deepMerge(this.fullState.R.SessionData, data);
          this.handleProdeSessionStatus(data);
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

  private handleProdeSessionStatus(data: any) {
    const status = String(data?.Status ?? data?.SessionStatus ?? data?.session_status ?? "").toLowerCase();
    if (!this.prodeService) return;
    if (!this.prodeSessionId) {
      if (status) this.pendingProdeStatus = data;
      return;
    }
    if (status === "started" || status === "active") {
      void this.prodeService.lockSession(this.prodeSessionId).catch((error) => console.error("Prode lock failed:", error));
    } else if (["ended", "finished", "finalised", "finalized"].includes(status) && this.evaluatedProdeSessionId !== this.prodeSessionId && this.evaluatingProdeSessionId !== this.prodeSessionId) {
      const sessionId = this.prodeSessionId;
      this.evaluatingProdeSessionId = sessionId;
        void this.prodeService.evaluateSession(sessionId, this.getProdeOfficialResults()).then(() => {
        this.evaluatedProdeSessionId = sessionId;
      }).catch((error) => console.error("Prode evaluation failed:", error)).finally(() => {
        if (this.evaluatingProdeSessionId === sessionId) this.evaluatingProdeSessionId = null;
      });
    }
  }
}

export { StateProcessor, StateProvider };
