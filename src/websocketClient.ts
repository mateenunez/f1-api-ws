import EventEmitter from "events";
import { WebSocket } from "ws";
import cbor from "cbor2";
import { StateProcessor } from "./stateProcessor";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";

class F1APIWebSocketsClient extends EventEmitter {
  private initAttempts = 0;
  private isInitializing = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private bridgeConnection: WebSocket | null = null;
  private bridgeUrl: string;
  private maxInitAttempts: number = 10;

  constructor(
    protected readonly stateProcessor: StateProcessor,
    private translationService: TranslationService,
    private transcriptionService: TranscriptionService,
    private clientCountProvider?: () => number,
  ) {
    super();
    this.setMaxListeners(0);
    this.bridgeUrl =
      process.env.BRIDGE_URL || "ws://f1telemetry.duckdns.org:5631";
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

  private decodeCBOR(data: Buffer): any {
    try {
      return cbor.decode(data);
    } catch {
      return null;
    }
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

  async connectToBridge(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log(`Connecting to bridge at ${this.bridgeUrl}...`);

        const ws = new WebSocket(this.bridgeUrl, {
          headers: {
            "bypass-tunnel-reminder": "true",
          },
        });
        this.bridgeConnection = ws;

        ws.on("open", () => {
          console.log("Connected to bridge successfully.");
          this.resetAttempts();
          resolve();
        });

        ws.on("message", async (data: Buffer) => {
          try {
            // Decode CBOR data from bridge
            const decodedData = this.decodeCBOR(data);
            // Handle SignalR-like message format from bridge
            if (decodedData.M && Array.isArray(decodedData.M)) {
              // Process each message in the batch
              for (const msg of decodedData.M) {
                if (msg.H === "Streaming" && msg.M === "feed") {
                  const [feedName, feedData, timestamp] = msg.A;
                  this.processBridgeFeed(feedName, feedData, timestamp);
                }
              }
            } else if (decodedData) {
              // Initial state update
              await this.stateProcessor.updateStatePremium(decodedData);
              this.addUserCountIfNeeded(this.stateProcessor.fullState);
              this.broadcast(data);
              console.log("Initial state received and broadcasted.");
            }
          } catch (err) {
            console.error("Error processing message:", err);
          }
        });

        ws.on("error", (err) => {
          console.error("Connection error:", err.message);
          reject(err);
        });

        ws.on("close", () => {
          console.log("Connection closed.");
          this.bridgeConnection = null;
          this.scheduleReconnect();
        });
      } catch (err) {
        console.error("Error connecting:", err);
        reject(err);
      }
    });
  }

  private processBridgeFeed(feedName: string, data: any, timestamp: string) {
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
      if (this.bridgeConnection) {
        this.bridgeConnection.close();
      }
    } catch {}
    this.bridgeConnection = null;
    this.resetAttempts();
  }

  async init() {
    if (this.isInitializing) {
      return;
    }
    this.isInitializing = true;
    try {
      await this.connectToBridge();
      return;
    } catch (error) {
      console.log("Error in init:", error);
      this.scheduleReconnect();
    } finally {
      this.isInitializing = false;
    }
  }
}

export { F1APIWebSocketsClient };
