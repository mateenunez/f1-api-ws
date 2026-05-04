import EventEmitter from "events";
import cbor from "cbor2";
import net from "net";
import { StateProcessor } from "./stateProcessor";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";

class F1APIWebSocketsClient extends EventEmitter {
  private initAttempts = 0;
  private isInitializing = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private tcpServer?: net.Server;
  private tcpClient?: net.Socket;
  private bridgePort: number;
  private bridgeHost: string;

  constructor(
    protected readonly stateProcessor: StateProcessor,
    private translationService: TranslationService,
    private transcriptionService: TranscriptionService,
    private clientCountProvider?: () => number,
    private maxInitAttempts: number = 10,
  ) {
    super();
    this.setMaxListeners(0);
    this.bridgePort = parseInt(process.env.DROPLET_PORT || "9000");
    this.bridgeHost = "127.0.0.1"; // Listen on localhost via SSH tunnel
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

  /**
   * Start TCP server to receive data from the bridge
   */
  private startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(
        `[TCP Server] Starting server on ${this.bridgeHost}:${this.bridgePort}...`
      );

      this.tcpServer = net.createServer((socket) => {
        console.log("[TCP Server] Client connected");
        this.tcpClient = socket;
        this.resetAttempts();

        socket.on("data", async (chunk) => {
          try {
            const data = chunk.toString();

            // Split by newline in case multiple messages are received
            const messages = data.split("\n").filter((msg) => msg.trim());

            for (const message of messages) {
              if (!message) continue;

              let parsedData: any;
              try {
                parsedData = JSON.parse(message);
              } catch (err) {
                console.error("[TCP Server] Error parsing JSON message:", err);
                continue;
              }

              // Process the data as if it came from F1
              await this.processBridgeData(parsedData);
            }
          } catch (err) {
            console.error("[TCP Server] Error processing data:", err);
          }
        });

        socket.on("error", (err) => {
          console.error("[TCP Server] Socket error:", err.message);
          this.tcpClient = undefined;
        });

        socket.on("close", () => {
          console.log("[TCP Server] Client disconnected. Reconnecting in 5s...");
          this.tcpClient = undefined;
          setTimeout(() => this.init(), 5000);
        });
      });

      this.tcpServer.listen(this.bridgePort, this.bridgeHost, () => {
        console.log(
          `[TCP Server] Server listening on ${this.bridgeHost}:${this.bridgePort}`
        );
        resolve();
      });

      this.tcpServer.on("error", (err) => {
        console.error("[TCP Server] Server error:", err.message);
        reject(err);
      });
    });
  }

  /**
   * Process data received from the bridge
   */
  private async processBridgeData(data: any): Promise<void> {
    try {
      // If it contains the full state (R), update it
      if (data.R) {
        await this.stateProcessor.updateStatePremium(data);
        try {
          this.addUserCountIfNeeded(this.stateProcessor.fullState);
          this.broadcast(this.encodeCBOR(this.stateProcessor.fullState));
          console.log("[TCP Server] Full state received and broadcasted.");
        } catch (error) {
          console.error("[TCP Server] Error broadcasting full state:", error);
        }
      }

      // If it's a streaming update (M array)
      if (Array.isArray(data.M)) {
        data.M.forEach((update: any) => {
          if (update.H === "Streaming" && update.M === "feed") {
            const [feedName, feedData, timestamp] = update.A;

            this.stateProcessor.processFeed(feedName, feedData, timestamp);

            if (
              feedName === "SessionInfo" &&
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
        this.addUserCountIfNeeded(data);
        this.broadcast(this.encodeCBOR(data));
      } catch (e) {
        console.error("[TCP Server] Error broadcasting data:", e);
      }
    } catch (err) {
      console.error("[TCP Server] Error processing bridge data:", err);
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
      if (this.tcpClient) {
        this.tcpClient.destroy();
      }
    } catch {}
    try {
      if (this.tcpServer) {
        this.tcpServer.close();
      }
    } catch {}
    this.tcpServer = undefined;
    this.tcpClient = undefined;
    this.resetAttempts();
  }

  async init() {
    if (this.isInitializing) {
      return;
    }
    this.isInitializing = true;
    try {
      // Start TCP server to listen for data from the bridge
      await this.startTcpServer();
      console.log("[WebSocket Client] TCP server initialized successfully.");
    } catch (error) {
      console.error("[WebSocket Client] Failed to start TCP server:", error);
      this.isInitializing = false;
      this.scheduleReconnect();
    }
    this.isInitializing = false;
  }
}

export { F1APIWebSocketsClient };
