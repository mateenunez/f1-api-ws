import { RedisClient } from "./redisClient";

interface FullState {
  R: any;
}

interface StateProvider {
  getState(): FullState;
}
class StateProcessor implements StateProvider {
  fullState: FullState;

  constructor(private redis: RedisClient) {
    this.fullState = {
      R: {},
    };
  }

  getState() {
    return this.fullState;
  }

  getPath() {
    return this.fullState.R?.SessionInfo?.Path ?? "";
  }

  getSessionId() {
    return this.fullState.R.SessionInfo.Meeting.Key ?? "";
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
    feedName: string
  ): Promise<Array<{ text: string | null }>> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) return [];

      let items = [];

      if (feedName === "TeamRadio") {
        items = this.fullState.R.TeamRadio.Captures || [];
      } else if (feedName === "RaceControlMessages") {
        items = this.fullState.R.RaceControlMessages.Messages || [];
      } else {
        items = this.fullState.R.RaceControlMessagesEs?.Messages || [];
      }
      if (!items || items.length === 0) return [];

      return (await this.redis.getList(sessionId, feedName, items)).filter(
        (it) => it !== null
      );
    } catch (err) {
      console.error(`Error fetching ${feedName} from Redis:`, err);
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
        (redisCapture: any) => capture.Utc === redisCapture.Utc
      );
      if (redisCapture) return redisCapture;
      else return capture;
    });
    this.fullState.R.TeamRadio = { Captures: mergedCaptures };
  }

  async updateState(newState: FullState) {
    this.fullState = newState;
    await this.updateRedis();
  }

  async updateStatePremium(newState: FullState) {
    this.fullState.R = newState;
    await this.updateRedis();
  }

  updatePartialState(path: string, data: any) {
    if (path === "R" && data) {
      this.fullState.R = data;
    } else {
      this.deepMerge(this.fullState, { [path]: data });
    }
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

      case "SessionInfo":
        if (this.fullState?.R?.SessionInfo) {
          this.deepMerge(this.fullState.R.SessionInfo, data);
        }
        break;

      case "SessionData":
        if (this.fullState?.R?.SessionData) {
          this.deepMerge(this.fullState.R.SessionData, data);
        }
        break;

      case "ExtrapolatedClock":
        if (this.fullState?.R?.ExtrapolatedClock) {
          this.deepMerge(this.fullState.R.ExtrapolatedClock, data);
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
