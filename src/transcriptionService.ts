import { AssemblyAI } from "assemblyai";

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

class TranscriptionService {
    private client: AssemblyAI;
    private readonly pollInterval = 1200; // ms
    private readonly timeout = 2 * 60 * 1000; // 2 minutes
    private readonly audioPrefix = "https://livetiming.formula1.com/static/"

    constructor(apiKey?: string) {
        const key = apiKey ?? process.env.ASSEMBLYAI_API_KEY;
        if (!key) throw new Error("AssemblyAI API key not provided (ASSEMBLYAI_API_KEY)");
        this.client = new AssemblyAI({ apiKey: key });
    }

    async transcribe(audioPath: string): Promise<string> {
        try {
            const path = this.audioPrefix + audioPath;
            const job = await this.client.transcripts.transcribe({
                audio: path,
                speech_model: "universal",
            });

            const id = (job as any).id ?? job;
            if (!id) {
                return (job as any).text ?? "";
            }

            const start = Date.now();
            while (Date.now() - start < this.timeout) {
                const statusObj: any = await this.client.transcripts.get(id);
                const status = statusObj?.status;
                if (status === "completed") {
                    return statusObj?.text ?? "";
                }
                if (status === "error") {
                    console.warn("AssemblyAI transcript error:", statusObj?.error);
                    return "";
                }
                await sleep(this.pollInterval);
            }

            console.warn("AssemblyAI transcription timed out for:", audioPath);
            return "";
        } catch (err) {
            console.error("Transcription error:", err);
            return "";
        }
    }

    async transcribeBulk(paths: string[], concurrency = 3): Promise<string[]> {
        if (!Array.isArray(paths)) return [];

        const results: string[] = new Array(paths.length).fill("");
        const queue = paths.map((p, idx) => ({ p, idx }));

        const workers: Promise<void>[] = new Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
            while (queue.length) {
                const item = queue.shift();
                if (!item) break;
                try {
                    const text = await this.transcribe(item.p);
                    results[item.idx] = text ?? "";
                } catch (e) {
                    console.error("Bulk transcription item error:", e);
                    results[item.idx] = "";
                }
            }
        });

        await Promise.all(workers);
        return results;
    }
}

export { TranscriptionService };