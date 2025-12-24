import EventEmitter from "events";
import axios, { AxiosError } from "axios";
import WebSocket from "ws";
import { StateProcessor } from "./stateProcessor";
import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";

class F1APIWebSocketsClient extends EventEmitter {
  private initAttempts = 0;
  private isInitializing = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private premiumConnection?: HubConnection;
  private commonSocket?: WebSocket;
  private localSocket?: WebSocket;

  constructor(
    protected readonly stateProcessor: StateProcessor,
    private translationService: TranslationService,
    private transcriptionService: TranscriptionService,
    private maxInitAttempts: number = 5
  ) {
    super();
    this.setMaxListeners(0);
  }

  broadcast(data: any) {
    this.emit("broadcast", data);
  }

  private isSessionInactive(data: any): boolean {
    if (!data) return false;
    const statusSeries = data.StatusSeries ?? data?.StatusSeries;
    if (!statusSeries || typeof statusSeries !== "object") return false;
    for (const k in statusSeries) {
      if (statusSeries[k]?.SessionStatus === "Inactive") return true;
    }
    return false;
  }

  async receivedInactiveSession(): Promise<void> {
    try {
      console.log(
        "Received Inactive session, forcing full dump (disconnect/reconnect)."
      );
      await this.disconnect();
      if (
        typeof (this.stateProcessor as any).updatePartialState === "function"
      ) {
        await (this.stateProcessor as any).updatePartialState("R", {});
      } else if (
        typeof (this.stateProcessor as any).updateState === "function"
      ) {
        await (this.stateProcessor as any).updateState({ R: {} });
      }
      // small delay to ensure sockets fully closed
      await new Promise((r) => setTimeout(r, 200));
      await this.init();
    } catch (err) {
      console.error("Error handling inactive session:", err);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.initAttempts < this.maxInitAttempts) {
      console.log("Attempting to reconnect, attempt:", this.initAttempts + 1);
      const delay = Math.pow(2, this.initAttempts) * 2000;
      setTimeout(() => {
        this.initAttempts++;
        this.init();
      }, delay);
    } else {
      console.log("Max reconnect attempts reached.");
    }
  }

  private resetAttempts() {
    this.initAttempts = 0;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  async commonNegotiation() {
    try {
      const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
      const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
      const res = await axios.get(url);
      return res;
    } catch (error) {
      const e: AxiosError = error as AxiosError;
      console.log("Error during negotiation:", e.response?.data || e.message);
      return Promise.reject(error);
    }
  }

  async commonWebSocketConnection(
    token: string,
    cookie: string
  ): Promise<WebSocket> {
    const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
    const encodedToken = encodeURIComponent(token);
    const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodedToken}&connectionData=${hub}`;
    return new Promise((res, rej) => {
      const sock = new WebSocket(url, {
        headers: {
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
          Cookie: cookie,
        },
      });

      this.commonSocket = sock;

      sock.on("open", () => {
        res(sock);
        this.resetAttempts();
      });

      sock.on("message", async (data) => {
        const parsedData = JSON.parse(data.toString());
        if (parsedData.R) {
          await this.stateProcessor.updateState(parsedData);
          this.broadcast(
            Buffer.from(JSON.stringify(this.stateProcessor.fullState))
          );
          console.log("Basic data subscription fullfilled and broadcasted.");
        }

        // Actualizar el estado de la variable on connection data
        if (Array.isArray(parsedData.M)) {
          parsedData.M.forEach((update: any) => {
            if (update.H === "Streaming" && update.M === "feed") {
              const [feedName, data, timestamp] = update.A;

              const snapshot = this.stateProcessor.getState();
              if (!snapshot || !snapshot.R) {
                return;
              }

              this.stateProcessor.processFeed(feedName, data, timestamp);

              if (feedName === "SessionData" && this.isSessionInactive(data)) {
                void this.receivedInactiveSession();
                return;
              }

              if (feedName === "RaceControlMessages") {
                this.receivedRaceControlMessage(feedName, data, timestamp);
              }

              if (feedName === "TeamRadio") {
                this.receivedTeamRadio(
                  feedName,
                  data,
                  timestamp,
                  this.stateProcessor.getPath()
                );
              }
            }
          });
        }

        this.broadcast(data);
      });

      sock.on("error", (err) => {
        console.error("Common websocket error:", err);
        rej(err);
      });

      sock.on("close", (code, reason) => {
        console.log(
          "Common websocket closed:",
          code,
          reason?.toString?.() ?? reason
        );
        this.commonSocket = undefined;
        this.scheduleReconnect();
      });
    });
  }

  async premiumNegotiation(subscriptionToken: string) {
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
      const e: AxiosError = error as AxiosError;
      console.log(
        "Error during premium negotiation:",
        e.response?.data || e.message
      );
      return Promise.reject(error);
    }
  }

  async premiumWebsocketConnect(
    subscriptionToken: string,
    cookies: string[]
  ): Promise<HubConnection> {
    const cookieString = cookies
      .map((cookie) => cookie.split(";")[0].trim())
      .join("; ");
    const connection = new HubConnectionBuilder()
      .withUrl("https://livetiming.formula1.com/signalrcore", {
        transport: HttpTransportType.WebSockets,
        accessTokenFactory: () => subscriptionToken,
        headers: {
          Cookie: cookieString,
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
        },
      })
      .configureLogging(LogLevel.Information)
      .build();

    this.premiumConnection = connection;

    connection.on("open", () => {
      this.resetAttempts();
    });

    connection.on("feed", (feedName, data, timestamp) => {
      this.stateProcessor.processFeed(feedName, data, timestamp);
      const streamingData = {
        M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
      };
      this.broadcast(Buffer.from(JSON.stringify(streamingData)));

      if (feedName === "SessionData" && this.isSessionInactive(data)) {
        void this.receivedInactiveSession();
        return;
      }

      if (feedName === "RaceControlMessages") {
        this.receivedRaceControlMessage(feedName, data, timestamp);
      }

      if (feedName === "TeamRadio") {
        this.receivedTeamRadio(
          feedName,
          data,
          timestamp,
          this.stateProcessor.getPath()
        );
      }
    });

    connection.onclose((error) => {
      console.log("Error at premium websocket: ", error);
      this.premiumConnection = undefined;
      this.scheduleReconnect();
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
        await this.stateProcessor.updateStatePremium(subscriptionData);
        this.broadcast(
          Buffer.from(JSON.stringify(this.stateProcessor.fullState))
        );
        console.log("Premium data subscription fullfilled and broadcasted.");
      }

      return connection;
    } catch (error) {
      console.error("Connection failed: ", error);
      return Promise.reject(error);
    }
  }

  async receivedRaceControlMessage(
    feedName: string,
    data: any,
    timestamp: string
  ) {
    try {
      const messagesObj = data?.Messages ?? data;
      if (!messagesObj || typeof messagesObj !== "object") return;

      const entries = Object.entries(messagesObj);
      const translatePromises = entries.map(([key, msgObj]: any) =>
        this.translationService
          .translate(msgObj?.Message ?? "")
          .then((translation) => ({
            key,
            msg: { ...(msgObj ?? {}), Message: translation },
          }))
          .catch(() => ({ key, msg: { ...(msgObj ?? {}) } }))
      );

      const translated = await Promise.all(translatePromises);

      const newMessages: Record<string, any> = {};
      translated.forEach(({ key, msg }) => {
        newMessages[key] = msg;
        this.stateProcessor.saveToRedis(feedName + "Es", { key, msg });
      });

      const translateData = { Messages: newMessages };

      this.stateProcessor.processFeed(
        feedName + "Es",
        translateData,
        timestamp
      );

      const streamingData = {
        M: [
          {
            H: "Streaming",
            M: "feed",
            A: [feedName + "Es", translateData, timestamp],
          },
        ],
      };
      this.broadcast(Buffer.from(JSON.stringify(streamingData)));
    } catch (err) {
      console.error("Error in receivedRaceControlMessage:", err);
    }
  }

  async receivedTeamRadio(
    feedName: string,
    data: any,
    timestamp: string,
    sessionPath: string
  ) {
    try {
      const capturesObj = data?.Captures ?? data;
      if (!capturesObj || typeof capturesObj !== "object") return;

      const entries = Object.entries(capturesObj);
      const promises = entries.map(async ([key, cap]: any) => {
        const path = cap?.Path ?? cap?.path;
        const utc = cap?.Utc ?? cap?.utc;
        let transcription = "";

        if (path && this.transcriptionService) {
          try {
            const fullPath = sessionPath + path;
            transcription =
              await this.transcriptionService.transcribe(fullPath);
          } catch (err) {
            console.error("Transcription error for path", path, err);
            transcription = "";
          }
        }

        const transcriptionEs =
          await this.translationService.translateTranscription(transcription);

        const copy = {
          ...(cap ?? {}),
          Transcription: transcription,
          TranscriptionEs: transcriptionEs,
        };
        if (utc) copy.Utc = utc;
        return [key, copy] as [string, any];
      });

      const results = await Promise.all(promises);
      const newCaptures: Record<string, any> = {};
      results.forEach(([key, cap]) => {
        newCaptures[key] = cap;
        this.stateProcessor.saveToRedis(feedName, { key, cap });
      });

      const payload = { Captures: newCaptures };

      this.stateProcessor.processFeed(feedName, payload, timestamp);

      const streamingData = {
        M: [{ H: "Streaming", M: "feed", A: [feedName, payload, timestamp] }],
      };
      this.broadcast(Buffer.from(JSON.stringify(streamingData)));
    } catch (err) {
      console.error("Error in receivedTeamRadio:", err);
    }
  }

  async localDebugWebsocketConnect(url: string): Promise<WebSocket> {
    return new Promise((res, rej) => {
      const sock = new WebSocket(url, {
        headers: {
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
        },
      });

      this.localSocket = sock;

      sock.on("open", () => {
        console.log("Connected to local debug websocket:", url);
        this.resetAttempts();
        res(sock);
      });

      sock.on("message", async (data) => {
        let parsedData: any;
        try {
          parsedData = JSON.parse(data.toString());
        } catch (err) {
          console.error("Error parsing message from local ws:", err);
          return;
        }

        if (parsedData.R) {
          await this.stateProcessor.updateState(parsedData);
          this.broadcast(
            Buffer.from(JSON.stringify(this.stateProcessor.fullState))
          );
          console.log(
            "Local debug: full state received/updated and broadcasted."
          );
        }

        if (Array.isArray(parsedData.M)) {
          parsedData.M.forEach((update: any) => {
            if (update.H === "Streaming" && update.M === "feed") {
              const [feedName, feedData, timestamp] = update.A;

              const snapshot = this.stateProcessor.getState();
              if (!snapshot || !snapshot.R) return;

              this.stateProcessor.processFeed(feedName, feedData, timestamp);

              if (
                feedName === "SessionData" &&
                this.isSessionInactive(feedData)
              ) {
                void this.receivedInactiveSession();
                return;
              }

              if (feedName === "RaceControlMessages") {
                this.receivedRaceControlMessage(feedName, feedData, timestamp);
              }

              if (feedName === "TeamRadio") {
                this.receivedTeamRadio(
                  feedName,
                  feedData,
                  timestamp,
                  this.stateProcessor.getPath()
                );
              }
            }
          });
        }

        try {
          this.broadcast(Buffer.from(JSON.stringify(parsedData)));
        } catch (e) {
          console.error("Error broadcasting local debug message:", e);
        }
      });

      sock.on("error", (err) => {
        console.error("Local websocket error:", err);
        rej(err);
      });

      sock.on("close", (code, reason) => {
        console.log(
          "Local websocket closed:",
          code,
          reason?.toString?.() ?? reason
        );
        this.localSocket = undefined;
        this.scheduleReconnect();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isInitializing = false;
    try {
      if (this.premiumConnection) {
        await this.premiumConnection.stop();
      }
    } catch {}
    try {
      if (this.commonSocket) {
        this.commonSocket.close();
      }
    } catch {}
    try {
      if (this.localSocket) {
        this.localSocket.close();
      }
    } catch {}
    this.premiumConnection = undefined;
    this.commonSocket = undefined;
    this.localSocket = undefined;
    this.resetAttempts();
  }

  async init() {
    if (this.isInitializing) {
      return;
    }
    this.isInitializing = true;
    try {
      const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN || "";
      const argvLocalws = process.argv.some((arg) => arg === "--localws");
      console.log("Local websocket flag is set as", argvLocalws)

      if (process.env.LOCALHOST_WEBSOCKET && argvLocalws) {
        const url = process.env.LOCALHOST_WEBSOCKET;
        try {
          await this.localDebugWebsocketConnect(url);
        } catch (localError) {
          console.warn("Local debug connection failed: ", localError);
        }
      } else {
        try {
          const negotiation = await this.premiumNegotiation(subscriptionToken);

          const cookies = negotiation.headers["set-cookie"] ?? [];

          if (negotiation && negotiation.status === 200) {
            if (negotiation.headers)
              await this.premiumWebsocketConnect(subscriptionToken, cookies);
            return;
          }
        } catch (premiumError) {
          console.warn("Premium connection failed: ", premiumError);
        }

        try {
          console.log("Started common negotiation.");

          const negotiationResponse = await this.commonNegotiation();

          const cookies: string[] =
            negotiationResponse.headers["set-cookie"] ?? [];

          const cookieString = cookies
            .map((cookie) => cookie.split(";")[0].trim())
            .join("; ");

          const sock = await this.commonWebSocketConnection(
            negotiationResponse.data["ConnectionToken"],
            cookieString
          );

          sock.send(
            JSON.stringify({
              H: "Streaming",
              M: "Subscribe",
              A: [
                [
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
                ],
              ],
              I: 1,
            })
          );
        } catch (commonError) {
          console.error("Common connection failed:", commonError);
        }
      }
    } catch (error) {
      console.log("Error in init:", error);
    } finally {
      this.isInitializing = false;
    }
  }
}

export { F1APIWebSocketsClient };
