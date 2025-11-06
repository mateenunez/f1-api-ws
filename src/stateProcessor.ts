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

  async saveToRedis(
    feedName: string,
    timestamp: string,
    data: any
  ): Promise<void> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) {
        console.error("No session ID at saveToRedis");
        return;
      }

      const serializedData = JSON.stringify(data);
      await this.redis.save(sessionId, feedName, timestamp, serializedData);
    } catch (err) {
      console.error(`Error saving ${feedName} to Redis:`, err);
    }
  }

  private getTimestampsFromFeed(
    feedObj: any,
    entriesKey = "Messages",
    timestampField = "Utc"
  ): string[] {
    if (!feedObj) return [];

    if (Array.isArray(feedObj[entriesKey])) {
      return this.extractTimestampsFromArray(
        feedObj[entriesKey],
        timestampField
      );
    }

    for (const k in feedObj) {
      if (feedObj[k] && Array.isArray(feedObj[k][entriesKey])) {
        return this.extractTimestampsFromArray(
          feedObj[k][entriesKey],
          timestampField
        );
      }
    }

    if (Array.isArray(feedObj)) {
      return this.extractTimestampsFromArray(feedObj, timestampField);
    }

    return [];
  }

  private extractTimestampsFromArray(
    arr: any[],
    timestampField = "Utc"
  ): string[] {
    return arr
      .map((m: any) =>
        m?.[timestampField] != null ? String(m[timestampField]) : null
      )
      .filter((u: string | null): u is string => u !== null && u !== "");
  }

  getRaceControlMessageTimestamps(raceControlMessagesObj: any): string[] {
    return this.getTimestampsFromFeed(
      raceControlMessagesObj,
      "Messages",
      "Utc"
    );
  }

  getTeamRadioTimestamps(teamRadioObj: any): string[] {
    return this.getTimestampsFromFeed(teamRadioObj, "Captures", "Utc");
  }

  async getListFromRedis(
    feedName: string
  ): Promise<Array<{ timestamp: string | number; text: string | null }>> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) return [];

      let timestamps: string[] = [];

      if (feedName === "TeamRadio") {
        timestamps = this.getTeamRadioTimestamps(this.fullState.R.TeamRadio);
      } else {
        timestamps = this.getRaceControlMessageTimestamps(
          this.fullState.R.RaceControlMessages
        );
      }
      if (!timestamps || timestamps.length === 0) return [];

      const items = timestamps.map((t) => ({ timestamp: t }));
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
        if (data.SessionStatus === "Inactive") {
          this.fullState.R.TimingAppData = null;
          this.fullState.R.TyreStintSeries = null;
          this.fullState.R.RaceControlMessages = [];
          this.fullState.R.RaceControlMessagesEs = [];
          this.fullState.R.TeamRadio = [];
          Object.keys(this.fullState.R.TimingData.Lines).forEach((key) => {
            if (
              this.fullState.R.TimingData.Lines[key] &&
              typeof this.fullState.R.TimingData.Lines[key] === "object"
            ) {
              this.fullState.R.TimingData.Lines[key].NumberOfPitStops = 0;
              this.fullState.R.TimingData.Lines[key].GapToLeader = "";
              this.fullState.R.TimingData.Lines[key].IntervalToPositionAhead =
                "";
              this.fullState.R.TimingData.Lines[key].TimeDiffToPositionAhead =
                "";
              this.fullState.R.TimingData.Lines[key].TimeDiffToFastest = "";
              this.fullState.R.TimingData.Lines[key].Stats = [];
              this.fullState.R.TimingData.Lines[key].Retired = false;
              this.fullState.R.TimingData.Lines[key].KnockedOut = false;
            }
          });
          Object.keys(this.fullState.R.TimingStats.Lines).forEach((key) => {
            if (
              this.fullState.R.TimingStats.Lines[key] &&
              typeof this.fullState.R.TimingStats.Lines[key] === "object"
            ) {
              this.fullState.R.TimingStats.Lines[
                key
              ].PersonalBestLapTime.Value = "";
              this.fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Lap =
                "";
              this.fullState.R.TimingStats.Lines[
                key
              ].PersonalBestLapTime.Position = "";
            }
          });
        }

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
