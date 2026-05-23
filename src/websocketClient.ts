import EventEmitter from "events";
import axios, { AxiosError } from "axios";
import cbor from "cbor2";
import { StateProcessor } from "./stateProcessor";
import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";
import { HttpsProxyAgent } from "https-proxy-agent";

class F1APIWebSocketsClient extends EventEmitter {
  private initAttempts = 0;
  private isInitializing = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private premiumConnection?: HubConnection;
  private httpsProxy?: string;

  constructor(
    protected readonly stateProcessor: StateProcessor,
    private translationService: TranslationService,
    private transcriptionService: TranscriptionService,
    private clientCountProvider?: () => number,
    private maxInitAttempts: number = 10,
  ) {
    super();
    this.setMaxListeners(0);
    this.httpsProxy = process.env.HTTPS_PROXY || "";

  }

  setClientCountProvider(provider: () => number): void {
    this.clientCountProvider = provider;
  }

  private shouldIncludeUserCount(): boolean {
    const sessionStatus =
      this.stateProcessor?.fullState?.R?.SessionInfo?.SessionStatus;
    return sessionStatus !== "Finalised";
  }

  private addUserCountIfNeeded(data: any): any {
    if (!this.shouldIncludeUserCount() || !this.clientCountProvider) {
      return data;
    }
    const WebsocketUsers: number = this.clientCountProvider();
    data.wsu = WebsocketUsers;
    return data;
  }

  broadcast(data: any) {
    this.emit("broadcast", data);
  }

  private encodeCBOR(data: any): Buffer {
    return Buffer.from(cbor.encode(data));
  }

  private isSessionInactive(data: any): boolean {
    if (!data) return false;
    const SessionStatus = data.SessionStatus ?? data?.SessionStatus;
    return SessionStatus === "Inactive";
  }

  async receivedInactiveSession(): Promise<void> {
    try {
      console.log("Received Inactive Session Info, restarting connection.");
      this.disconnect();
      this.init();
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

      console.log("Negotiating with F1TV API...");
      
      const axiosConfig: any = { headers };
      
      if (this.httpsProxy) {
        const agent = new HttpsProxyAgent(this.httpsProxy);
        axiosConfig.httpAgent = agent;
        axiosConfig.httpsAgent = agent;
        console.log("Using proxy for negotiation");
      }

      const response = await axios.post(url, null, axiosConfig);
      return response;
    } catch (error) {
      const e: AxiosError = error as AxiosError;
      console.log(
        "Error during premium negotiation:",
        e.response?.data || e.message,
      );
      return Promise.reject(error);
    }
  }

  async premiumWebsocketConnect(
    subscriptionToken: string,
    cookies: string[],
  ): Promise<HubConnection> {
    const cookieString = cookies
      .map((cookie) => cookie.split(";")[0].trim())
      .join("; ");

    console.log("Connecting to F1 WebSocket...");
    if (this.httpsProxy) {
      console.log("Using proxy for WebSocket");
    }

    const connectionConfig: any = {
      transport: HttpTransportType.WebSockets,
      accessTokenFactory: () => subscriptionToken,
      headers: {
        Cookie: cookieString,
        "User-Agent": "BestHTTP",
        "Accept-Encoding": "gzip,identity",
      },
    };

    if (this.httpsProxy) {
      const agent = new HttpsProxyAgent(this.httpsProxy);
      connectionConfig.agent = agent;
    }

    const connection = new HubConnectionBuilder()
      .withUrl("https://livetiming.formula1.com/signalrcore", connectionConfig)
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

      this.addUserCountIfNeeded(streamingData);
      this.broadcast(this.encodeCBOR(streamingData));

      if (feedName === "SessionInfo" && this.isSessionInactive(data)) {
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
          this.stateProcessor.getPath(),
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
        try {
          this.addUserCountIfNeeded(this.stateProcessor.fullState);
          this.broadcast(this.encodeCBOR(this.stateProcessor.fullState));
          console.log("Premium data subscription fullfilled and broadcasted.");
        } catch (error) {
          console.error("Error broadcasting premium data:", error);
        }
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
    timestamp: string,
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
          .catch(() => ({ key, msg: { ...(msgObj ?? {}) } })),
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
        timestamp,
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
      this.broadcast(this.encodeCBOR(streamingData));
    } catch (err) {
      console.error("Error in receivedRaceControlMessage:", err);
    }
  }

  async receivedTeamRadio(
    feedName: string,
    data: any,
    timestamp: string,
    sessionPath: string,
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
          await this.translationService.translate(transcription);

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
      this.broadcast(this.encodeCBOR(streamingData));
    } catch (err) {
      console.error("Error in receivedTeamRadio:", err);
    }
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
    this.premiumConnection = undefined;
    this.resetAttempts();
  }

  async init() {
    if (this.isInitializing) {
      return;
    }
    this.isInitializing = true;
    try {
      const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN || "";

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
    } catch (error) {
      console.log("Error in init:", error);
    } finally {
      this.isInitializing = false;
    }
  }
}

export { F1APIWebSocketsClient };
