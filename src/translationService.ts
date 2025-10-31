import { GoogleGenAI, Type } from "@google/genai";

interface TranslationProvider {
    translate(message: string, targetLanguage: string): Promise<string | undefined>
}

class TranslationService implements TranslationProvider {
    ai: GoogleGenAI;

    constructor() {
        this.ai = new GoogleGenAI({});
    }

    async translate(message: string, targetLanguage: string = "spanish"): Promise<string | undefined> {
        try {
            const prompt = `Translate the following message to ${targetLanguage}: "${message}"`;
            const response = await this.ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    systemInstruction: `You are a translation engine for Formula 1 team radio messages, you have to return in upper case the translated message only in the indicated language: ${targetLanguage}, keeping the text simple but understandable.`
                }
            })
            return response.text || undefined;
        } catch (error) {
            console.log("Translation error:", error)
        }
    }

    async translateTranscription(message: string, targetLanguage: string = "spanish"): Promise<string | undefined> {
        try {
            const prompt = `Translate the following message to ${targetLanguage}: "${message}"`;
            const response = await this.ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    systemInstruction: `You are a translation engine for Formula 1 team radio audio messages, translate the text given to the language: ${targetLanguage}, keeping the text simple but understandable.`
                }
            })
            return response.text || undefined;
        } catch (error) {
            console.log("Translation error:", error)
        }
    }

    async translateBulk(messages: string[], targetLanguage: string = "spanish"): Promise<(string | undefined)[]> {
        const prompt = `Translate the following messages to ${targetLanguage}. Return only the translations in a JSON array format in upper case without any additional text: ${JSON.stringify(messages)}`;
        const response = await this.ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json", // Indica que la respuesta es JSON
                responseSchema: {
                    type: Type.ARRAY,
                    description: "List of translated messages",
                    items: {
                        type: Type.STRING,
                    }
                },
                systemInstruction: `You are a translation engine for Formula 1 team radio messages, you have to return in upper case the translated message only in the indicated language: ${targetLanguage}, keeping the text simple but understandable.`
            }
        })

        try {
            if (!response.text) return [];
            const translatedArray = JSON.parse(response.text);
            return translatedArray as string[];
        } catch (e) {
            console.error("Error al parsear la respuesta JSON de la API:", e);
            throw new Error("Formato de traducción inválido.");
        }
    }

}

export { TranslationService, TranslationProvider }