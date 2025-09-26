const EventEmitter = require("events");

class StateProcessor extends EventEmitter {
  constructor() {
    super();
    this.fullState = { R: {} };
  }

  getState() {
    return this.fullState;
  }

  updateState(newState) {
    this.fullState = newState;
    this.emit('stateUpdated', this.fullState);
  }

  updateStatePremium(newState) {
    this.fullState.R = newState;
    this.emit('stateUpdated', this.fullState);
  }

  updatePartialState(path, data) {
    if (path === 'R' && data) {
      this.fullState.R = data;
    } else {
      this.deepMerge(this.fullState, { [path]: data });
    }
    this.emit('stateUpdated', this.fullState);
  }

  deepMerge(target, source) {
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

  processFeed(feedName, data, timestamp) {
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

      case "SessionInfo":
        if (this.fullState?.R?.SessionInfo) {
          if (data.SessionStatus === "Inactive") {
            console.log("Inactive session detected, cleaning some attributes...");
            this.fullState.R.TimingAppData = null;
            this.fullState.R.TyreStintSeries = null;
            // ... resto de la lógica de limpieza
          }
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

    // Emitir evento con los datos procesados
    this.emit('feedProcessed', {
      feedName,
      data,
      timestamp,
      fullState: this.fullState
    });
  }
}

// Singleton pattern
let instance = null;

module.exports = {
  StateProcessor,
  getInstance: () => {
    if (!instance) {
      instance = new StateProcessor();
    }
    return instance;
  }
};