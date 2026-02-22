import { GoogleGenAI, Type } from "@google/genai";
import { Translator, TargetLanguageCode } from "deepl-node";

interface TranslationProvider {
  translate(
    message: string,
    targetLanguage: string,
  ): Promise<string | undefined>;
}

class TranslationService implements TranslationProvider {
  ai: GoogleGenAI;
  deeplClient: Translator;
  backoffMs: number = 12000;
  private queue: Array<{
    call: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }> = [];
  private isBackoff = false;
  private workerRunning = false;
  private backoffTimer?: NodeJS.Timeout;
  private backoffPromise: Promise<void> | null = null;

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

  constructor() {
    this.ai = new GoogleGenAI({});
    const key = process.env.DEEPL_API_KEY;
    if (!key) throw new Error("Deepl API key not provided (DEEPL_API_KEY)");
    this.deeplClient = new Translator(key);
  }

  async translateWithDeepL(
    message: string,
    targetLang: string = "es",
  ): Promise<string | undefined> {
    try {
      const result = await this.deeplClient.translateText(
        message,
        null,
        targetLang as TargetLanguageCode,
      );
      return result.text.toUpperCase();
    } catch (error) {
      console.error("DeepL translation failed.", error);
      return undefined;
    }
  }

  async translate(
    message: string,
    targetLanguage: string = "spanish",
  ): Promise<string | undefined> {
    return this.enqueueApiCall(async () => {
      try {
        const prompt = `Translate the following message to ${targetLanguage}: "${message}"`;
        const response = await this.ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: {
            systemInstruction: `You are a translation engine for Formula 1 team radio messages, you have to return in upper case the translated message only in the indicated language: ${targetLanguage}, keeping the text simple but understandable.`,
          },
        });
        const translated = response.text?.trim();
        if (translated) return translated.toUpperCase();
      } catch (error) {
        console.log("Gemini translation failed.", error);
      }
      return await this.translateWithDeepL(message);
    });
  }
}

export { TranslationService, TranslationProvider };
