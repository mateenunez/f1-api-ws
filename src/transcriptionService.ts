import { AssemblyAI } from "assemblyai";

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

class TranscriptionService {
  private client: AssemblyAI;
  private readonly pollInterval = 1200; // ms
  private readonly timeout = 2 * 60 * 1000; // 2 minutes
  private readonly audioPrefix = "https://livetiming.formula1.com/static/";
  private backoffMs: number = 12000;
  private queue: Array<{
    call: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }> = [];
  private isBackoff = false;
  private workerRunning = false;
  private backoffTimer?: NodeJS.Timeout;
  private backoffPromise: Promise<void> | null = null;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ASSEMBLYAI_API_KEY;
    if (!key)
      throw new Error("AssemblyAI API key not provided (ASSEMBLYAI_API_KEY)");
    this.client = new AssemblyAI({ apiKey: key });
  }

  private enqueueApiCall<T>(call: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ call, resolve, reject });
      this.startWorker();
    });
  }

  private async startWorker(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (this.queue.length) {
        // wait while backoff active
        if (this.isBackoff) {
          if (!this.backoffPromise) {
            this.backoffPromise = new Promise((res) => {
              this.backoffTimer = setTimeout(() => {
                this.isBackoff = false;
                this.backoffPromise = null;
                res();
              }, this.backoffMs);
            });
          }
          await this.backoffPromise;
        }

        const task = this.queue.shift()!;
        try {
          const result = await task.call();
          task.resolve(result);
        } catch (err) {
          task.reject(err);
        }

        // activate backoff after each request
        this.isBackoff = true;
        // ensure next loop will wait on backoffPromise
        this.backoffPromise = new Promise((res) => {
          if (this.backoffTimer) clearTimeout(this.backoffTimer);
          this.backoffTimer = setTimeout(() => {
            this.isBackoff = false;
            this.backoffPromise = null;
            res();
          }, this.backoffMs);
        });
      }
    } finally {
      this.workerRunning = false;
    }
  }

  async transcribe(audioPath: string): Promise<string> {
    return this.enqueueApiCall(async () => {
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
        throw err;
      }
    });
  }
}

export { TranscriptionService };
