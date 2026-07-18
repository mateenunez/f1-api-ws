import { Server as HttpServer, IncomingMessage } from "http";
import { StateProvider } from "./stateProcessor";
import { WebSocket, WebSocketServer } from "ws";
import EventEmitter from "events";
import { RedisClient } from "./redisClient";
import cbor from "cbor2";
import { UserService } from "./userService";
import { RoleService } from "./roleService";

interface AuthenticatedSocket extends WebSocket {
  user?: any;
  isAuthenticated?: boolean;
  hasFullDataAccess?: boolean;
}

interface AuthenticatedRequest extends IncomingMessage {
  authUser?: any;
}

class WebSocketTelemetryServer {
  private wss: WebSocketServer;

  private encodeCBOR(value: any): Buffer {
    return Buffer.from(cbor.encode(value));
  }

  private normalizeOutgoingMessage(data: any): Buffer {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      try {
        cbor.decode(data);
        return Buffer.from(data);
      } catch {
        try {
          const parsed = JSON.parse(Buffer.from(data).toString());
          return this.encodeCBOR(parsed);
        } catch {
          return this.encodeCBOR(Buffer.from(data).toString());
        }
      }
    }

    if (typeof data === "string") {
      try {
        return this.encodeCBOR(JSON.parse(data));
      } catch {
        return this.encodeCBOR(data);
      }
    }

    return this.encodeCBOR(data);
  }

  private decodeWebSocketMessage(rawData: any): any {
    const buffer = Buffer.isBuffer(rawData)
      ? rawData
      : rawData instanceof ArrayBuffer
      ? Buffer.from(rawData)
      : Array.isArray(rawData)
      ? Buffer.concat(rawData.map((chunk) => Buffer.from(chunk)))
      : Buffer.from(rawData.toString());

    try {
      return cbor.decode(buffer);
    } catch {
      const text = buffer.toString();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  /**
   * Feed names that require full data access (see resolveFullDataAccess).
   * - Position / Position.z : pilot XYZ positions on the map
   * - RaceControlMessagesEs : Spanish translations (CPU-expensive via Gemini)
   * TeamRadio is handled separately: audio URLs are public, transcriptions are gated.
   */
  private readonly AUTH_REQUIRED_FEEDS = new Set([
    "Position",
    "Position.z",
    "RaceControlMessagesEs",
  ]);

  /**
   * Strip auth-gated data from a streaming message object.
   * Returns null if the entire message should be suppressed.
   */
  private filterMessageForUnauthenticated(data: any): any | null {
    // Streaming feed packet: { M: [{ H, M, A: [feedName, feedData, ts] }] }
    if (Array.isArray(data?.M)) {
      const filteredM = data.M.map((msg: any) => {
        if (msg.H !== "Streaming" || msg.M !== "feed") return msg;
        const [feedName, feedData, timestamp] = msg.A ?? [];

        // Completely suppress position and translation feeds
        if (this.AUTH_REQUIRED_FEEDS.has(feedName)) return null;

        // TeamRadio: keep audio capture paths but strip transcription fields
        if (feedName === "TeamRadio") {
          return {
            ...msg,
            A: [feedName, this.stripTeamRadioTranscriptions(feedData), timestamp],
          };
        }

        return msg;
      }).filter(Boolean);

      if (filteredM.length === 0) return null;
      return { ...data, M: filteredM };
    }

    return data;
  }

  /**
   * Remove Transcription and TranscriptionEs from every TeamRadio capture.
   */
  private stripTeamRadioTranscriptions(data: any): any {
    if (!data || typeof data !== "object") return data;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const stripCapture = ({ Transcription, TranscriptionEs, ...rest }: any) => rest;

    if (Array.isArray(data.Captures)) {
      return { ...data, Captures: data.Captures.map(stripCapture) };
    }
    if (data.Captures && typeof data.Captures === "object") {
      const strippedCaptures: Record<string, any> = {};
      for (const [k, v] of Object.entries(data.Captures)) {
        strippedCaptures[k] = stripCapture(v);
      }
      return { ...data, Captures: strippedCaptures };
    }

    return data;
  }

  /**
   * Strip auth-gated fields from the full initial state snapshot.
   * Returns a new object safe to send to unauthenticated clients.
   */
  private filterStateForUnauthenticated(snapshot: any): any {
    if (!snapshot?.R) return snapshot;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      Position,
      "Position.z": positionZ,
      RaceControlMessagesEs,
      TeamRadio,
      ...restR
    } = snapshot.R;

    const filteredR: any = { ...restR };

    // Keep TeamRadio structure but strip transcription fields from captures
    if (TeamRadio) {
      filteredR.TeamRadio = this.stripTeamRadioTranscriptions(TeamRadio);
    }

    return { ...snapshot, R: filteredR };
  }

  /**
   * Extracts the auth token from the connection handshake so authentication
   * can be resolved before the socket is accepted, avoiding the race where
   * the initial state snapshot is sent before a post-connect auth message
   * would have arrived.
   * Checks the `token` query param first (works cross-origin, e.g. a
   * frontend on a different subdomain than the API), then falls back to
   * the `f1t_auth` cookie for same-origin deployments.
   */
  private extractToken(req: IncomingMessage): string | null {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const queryToken = url.searchParams.get("token");
      if (queryToken) return queryToken;
    } catch {
      // ignore malformed URL, fall back to cookie
    }

    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("f1t_auth="));
      if (match) return decodeURIComponent(match.slice("f1t_auth=".length));
    }

    return null;
  }

  /**
   * Whether a logged-in user's role is in the admin-configurable set of
   * roles that receive full telemetry data. Defaults to every role until
   * an admin narrows it via PUT /settings/full-data-roles.
   */
  private async resolveFullDataAccess(user: any): Promise<boolean> {
    const roleId = user?.role?.id;
    if (roleId == null) return false;
    const allowedRoleIds = await this.roleService.getFullDataRoleIds();
    return allowedRoleIds.includes(roleId);
  }

  private sendInitialState(ws: AuthenticatedSocket) {
    const snapshot = this.stateProcessor.getState();

    if (snapshot != null) {
      const payload = ws.hasFullDataAccess
        ? snapshot
        : this.filterStateForUnauthenticated(snapshot);
      ws.send(this.encodeCBOR(payload));
    }
  }

  constructor(
    server: HttpServer,
    private stateProcessor: StateProvider,
    eventBus: EventEmitter,
    redis: RedisClient,
    private userService: UserService,
    private roleService: RoleService,
  ) {
    if (!server) {
      throw new Error(
        "WebSocketServer requires an HTTP server as the first argument.",
      );
    }

    this.wss = new WebSocketServer({
      server,
      clientTracking: true,
      verifyClient: async (
        info: { origin: string; secure: boolean; req: AuthenticatedRequest },
        callback: (verified: boolean) => void,
      ) => {
        try {
          const token = this.extractToken(info.req);
          if (token) {
            const result = await this.userService.verifyToken(token);
            if (result?.user) {
              info.req.authUser = result.user;
            }
          }
        } catch {
          // Invalid/expired token: connection still proceeds, just unauthenticated.
        }
        callback(true);
      },
    });
    // Single shared subscription for the server's lifetime, instead of one
    // eventBus listener per connected client. filterMessageForUnauthenticated
    // + encodeCBOR only ever produce two distinct outputs per broadcast (full
    // access vs. filtered), so each is computed at most once here and reused
    // across every client on that side of the split, rather than redone once
    // per socket (O(clients) CBOR encodes per feed tick otherwise).
    eventBus.on("broadcast", (data: any) => this.handleBroadcast(data));

    this.wss.on("connection", async (ws: AuthenticatedSocket, req: AuthenticatedRequest) => {
      if (req.authUser) {
        ws.user = req.authUser;
        ws.isAuthenticated = true;
        ws.hasFullDataAccess = await this.resolveFullDataAccess(req.authUser);
      }

      this.sendInitialState(ws);

      ws.on("message", async (rawData) => {
        try {
          const data = this.decodeWebSocketMessage(rawData);

          switch (data.type) {
            case "auth:token":
              try {
                const token = data.payload.token;
                if (!token) {
                  ws.send(this.encodeCBOR({ error: "No token given." }));
                }

                const result = await this.userService.verifyToken(token);
                if (!result) {
                  ws.send(this.encodeCBOR({ error: "Invalid token" }));
                  return;
                }
                ws.user = result.user;
                ws.isAuthenticated = true;
                ws.hasFullDataAccess = await this.resolveFullDataAccess(
                  result.user,
                );

                ws.send(
                  this.encodeCBOR({
                    success: true,
                    message: "Authenticated",
                  }),
                );
              } catch (error) {
                ws.isAuthenticated = false;
                ws.hasFullDataAccess = false;
                ws.send(this.encodeCBOR({ error: "Invalid token" }));
                console.log("Authentication failed.");
              }
              break;

            case "get:state": {
              const snapshot = this.stateProcessor.getState();
              if (snapshot != null) {
                const payload = ws.hasFullDataAccess
                  ? snapshot
                  : this.filterStateForUnauthenticated(snapshot);
                ws.send(this.encodeCBOR(payload));
              }
              break;
            }

            default:
              console.log("Unhandled event.", data.type, data.content);
          }
        } catch (error) {
          console.error("Error at websocket server message.");
        }
      });
    });
  }

  private encodeForSend(payload: any): Buffer {
    // Event bus emits plain objects; encode to CBOR. If a raw buffer arrives
    // (legacy fallback), normalise it instead.
    return Buffer.isBuffer(payload) || payload instanceof Uint8Array
      ? this.normalizeOutgoingMessage(payload)
      : this.encodeCBOR(payload);
  }

  /**
   * Fan out one broadcast event to every connected client, computing the
   * full-access and filtered CBOR encodings at most once each per event
   * (instead of once per client) and reusing them across all clients on
   * that side of the auth split.
   */
  private handleBroadcast(data: any) {
    if (this.wss.clients.size === 0) return;

    let fullEncoded: Buffer | undefined;
    // undefined = not yet computed; null = filtered result is fully suppressed
    let filteredEncoded: Buffer | null | undefined;

    for (const client of this.wss.clients) {
      const ws = client as AuthenticatedSocket;
      if (ws.readyState !== WebSocket.OPEN) continue;

      try {
        if (ws.hasFullDataAccess) {
          if (fullEncoded === undefined) {
            fullEncoded = this.encodeForSend(data);
          }
          ws.send(fullEncoded);
        } else {
          if (filteredEncoded === undefined) {
            const filteredPayload = this.filterMessageForUnauthenticated(data);
            filteredEncoded =
              filteredPayload === null ? null : this.encodeForSend(filteredPayload);
          }
          if (filteredEncoded !== null) ws.send(filteredEncoded);
        }
      } catch (err) {
        console.error("Error sending broadcast message:", err);
      }
    }
  }

  getClientCount(): number {
    return this.wss.clients.size;
  }
}

export { WebSocketTelemetryServer };
