import { Server } from "http";
import stateProcessor from "./stateProcessor";
import WebSocket from "ws";
import EventEmitter from "events";

class WebSocketServer {
  private state: any;
  public wss: WebSocket.Server;

  constructor(server: Server, eventBus: EventEmitter) {
    if (!server) {
      throw new Error(
        "WebSocketServer requires an HTTP server as the first argument."
      );
    }
    this.state = stateProcessor.getInstance();

    this.wss = new WebSocket.Server({ server, clientTracking: true });
    this.wss.on("connection", (ws) => {
      const eventListener = (data: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      };

      console.log("Clients connected: " + this.wss.clients.size)

      const snapshot = this.state.getState();

      if (snapshot != null) {
        const buffer = Buffer.from(JSON.stringify(snapshot));
        eventListener(buffer);
      }

      eventBus.on('broadcast', eventListener)

      ws.on("close", () => {
        eventBus.off('broadcast', eventListener)
      });
    });
  }
}

export default WebSocketServer;
