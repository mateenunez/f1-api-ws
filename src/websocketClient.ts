import EventEmitter from "events";
import axios, { AxiosError } from "axios";
import WebSocket from "ws";
import stateProcessor from "./stateProcessor";
import { HttpTransportType, HubConnection, HubConnectionBuilder, LogLevel } from "@microsoft/signalr";

class WebSocketClient extends EventEmitter {
    public state: any;

    constructor() {
        super()
        this.state = stateProcessor.getInstance()
    }

    broadcast(data: any) {
        this.emit("broadcast", data);
    }

    async commonNegotiation() {
        try {
            const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
            const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
            const res = await axios.get(url);
            return res;
        } catch (error) {
            const e: AxiosError = error as AxiosError;
            console.log(
                "Error during negotiation:",
                e.response?.data || e.message
            );
            return Promise.reject(error);
        }

    }

    async commonWebSocketConnection(token: string, cookie: string): Promise<WebSocket> {
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

            sock.on("open", () => {
                res(sock);
            });

            sock.on("message", (data) => {
                // Guardar ultima información de retransmisión
                const parsedData = JSON.parse(data.toString());
                if (parsedData.R) {
                    this.state.updateState(parsedData);
                    console.log("Basic data subscription fullfilled");
                }

                // Actualizar el estado de la variable on connection data
                if (Array.isArray(parsedData.M)) {
                    parsedData.M.forEach((update: any) => {
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

                this.broadcast(data);
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

    async premiumWebsocketConnect(subscriptionToken: string, cookies: string[]): Promise<HubConnection> {
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

        connection.on("feed", (feedName, data, timestamp) => {
            this.state.processFeed(feedName, data, timestamp);
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

export default WebSocketClient;