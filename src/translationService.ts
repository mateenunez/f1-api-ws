import { GoogleGenAI } from "@google/genai";

interface TranslationProvider {
    translate(message: string, targetLanguage: string): Promise<string | undefined>
}

class TranslationService implements TranslationProvider {
    api_key: string;
    ai: GoogleGenAI;

    constructor(api_key: string) {
        this.api_key = api_key;
        this.ai = new GoogleGenAI({});
    }

    async translate(message: string, targetLanguage: string = "spanish"): Promise<string | undefined> {
        try {
            const prompt = `Translate the following message to ${targetLanguage}: "${message}"`;
            const response = await this.ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    systemInstruction: "You are a translation engine for Formula 1 team radio messages, you have to return the translated message only, without any additional text."
                }
            })
            return response.text;
        } catch (error) {
            console.log("Translation error:", error)
        }
    }

}

export { TranslationService, TranslationProvider }