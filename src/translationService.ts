import { GoogleGenAI } from "@google/genai";

interface TranslationProvider {
    translate(message: string, targetLanguage: string): Promise<string | undefined>
}

class TranslationService implements TranslationProvider {
    private api_key: string;
    ai: GoogleGenAI;

    constructor(private key: string) {
        this.api_key = key;
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

    async translateBulk(messages: string[], targetLanguage: string = "spanish"): Promise<(string | undefined)[]> {
        const prompt = `Translate the following messages to ${targetLanguage}. Return only the translations in a JSON array format without any additional text: ${JSON.stringify(messages)}`;
        const response = await this.ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json", // Indica que la respuesta es JSON
                responseSchema: {
                    type: Array,
                    description: "List of translated messages",
                    items: {
                        type: String,
                    }
                }
            }
        })

        try {
            if (!response.text) return Error("No response from translation API") as any;
            const translatedArray = JSON.parse(response.text);
            return translatedArray as string[];
        } catch (e) {
            console.error("Error al parsear la respuesta JSON de la API:", e);
            throw new Error("Formato de traducción inválido.");
        }
    }

}

export { TranslationService, TranslationProvider }