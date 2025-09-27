const WebSocket = require("ws");
const EventEmitter = require("events");
const signalR = require("@microsoft/signalr");
const { getInstance } = require("./stateProcessor");
const axios = require("axios");

class WebSocketServer extends EventEmitter {
  constructor(server) {
    super();
    if (!server) {
      throw new Error(
        "WebSocketServer requires an HTTP server as the first argument"
      );
    }
    this.state = getInstance();

    this.clients = 0;

    this.broadcastEmitter = new EventEmitter();

    this.wss = new WebSocket.Server({ server });
    this.wss.on("connection", (ws) => {
      const messageForwarder = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      };

      this.clients++;

      const snapshot = this.state.getState();
      if (snapshot != null) {
        const buffer = Buffer.from(JSON.stringify(snapshot));
        ws.send(buffer);
      }

      this.broadcastEmitter.on("broadcast", messageForwarder);
      ws._messageForwarder = messageForwarder;

      ws.on("close", () => {
        this.broadcastEmitter.removeListener("broadcast", ws._messageForwarder);
        --this.clients;
      });

      console.log("New client connected. Total clients: %d", this.clients);
    });
  }

  broadcast(data) {
    this.broadcastEmitter.emit("broadcast", data);
  }

  async commonNegotiation() {
    const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
    const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
    const resp = await axios.get(url);
    return resp;
  }

  async websocketConnect(token, cookie) {
    const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
    const encodedToken = encodeURIComponent(token);
    const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodedToken}&connectionData=${hub}`;
    const p = new Promise((res, rej) => {
      const sock = new ws.WebSocket(url, {
        headers: {
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
          Cookie: cookie,
        },
      });

      sock.on("open", (ev) => {
        res(sock);
      });

      sock.on("message", (data) => {
        // Guardar ultima información de retransmisión
        const parsedData = JSON.parse(data);
        if (parsedData.R) {
          this.state.updateState(parsedData);
          console.log("Basic data subscription fullfilled");
        }

        // Actualizar el estado de la variable on connection data
        if (Array.isArray(parsedData.M)) {
          console.log("Basic streaming data received");
          parsedData.M.forEach((update) => {
            if (update.H === "Streaming" && update.M === "feed") {
              const [feedName, data, timestamp] = update.A;

              const snapshot = this.state.getState();
              if (!snapshot || !snapshot.R) {
                return;
              }

              this.state.processFeed(feedName, data, timestamp);
            }
          });
        }

        // this.clients.forEach((ws) => {
        //   if (ws.readyState === WebSocket.OPEN) {
        //     ws.send(data);
        //   }
        // });

        this.broadcast(data);
      });
    });
    return p;
  }

  async premiumNegotiation(subscriptionToken) {
    try {
      const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
      const url = `https://livetiming.formula1.com/signalrcore/negotiate?connectionData=${hub}&clientProtocol=1.5`;
      const headers = {
        Authorization: `Bearer ${subscriptionToken}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        Origin: "https://account.formula1.com",
        Referer: "https://account.formula1.com/",
        "Content-Type": "application/json",
      };
      const response = await axios.post(url, null, { headers });
      return response;
    } catch (error) {
      console.log(
        "Error during negotiation:",
        error.response?.data || error.message
      );
    }
  }

  async premiumWebsocketConnect(subscriptionToken, cookies) {
    const cookieString = cookies
      .map((cookie) => cookie.split(";")[0].trim())
      .join("; ");
    const connection = new signalR.HubConnectionBuilder()
      .withUrl("https://livetiming.formula1.com/signalrcore", {
        transport: signalR.HttpTransportType.WebSockets,
        accessTokenFactory: () => subscriptionToken,
        headers: {
          Cookie: cookieString,
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
        },
      })
      .configureLogging(signalR.LogLevel.Information)
      .build();

    connection.on("feed", (feedName, data, timestamp) => {
      this.state.processFeed(feedName, data, timestamp);
      // this.clients.forEach((ws) => {
      //   if (ws.readyState === WebSocket.OPEN) {
      //     const streamingData = {
      //       M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
      //     };
      //     ws.send(Buffer.from(JSON.stringify(streamingData)));
      //   }
      // });
      const streamingData = {
        M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
      };
      this.broadcast(Buffer.from(JSON.stringify(streamingData)));
    });

    connection.onclose((error) => {
      console.log("Error at premium websocket: ", error);
      return error;
    });

    try {
      await connection.start();

      const subscriptionData = await connection.invoke("Subscribe", [
        "Heartbeat",
        "CarData",
        "Position",
        "ExtrapolatedClock",
        "TopThree",
        "TimingStats",
        "TimingAppData",
        "WeatherData",
        "TrackStatus",
        "DriverList",
        "RaceControlMessages",
        "SessionInfo",
        "SessionData",
        "LapCount",
        "TimingData",
        "TyreStintSeries",
        "TeamRadio",
        "CarData.z",
        "Position.z",
      ]);

      if (subscriptionData) {
        console.log("Premium data subscription fullfilled.");
        this.state.updateStatePremium(subscriptionData);
      }

      return connection;
    } catch (error) {
      console.error("Connection failed: ", error);
      throw error;
    }
  }
}

module.exports = WebSocketServer;
