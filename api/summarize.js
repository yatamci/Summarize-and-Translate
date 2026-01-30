import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        /* 1️⃣ Body parsen */
        const body = typeof req.body === "string" 
            ? JSON.parse(req.body) 
            : req.body;

        const { url, language } = body;

        if (!url || !language) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        /* 2️⃣ Webseite laden */
        const pageResponse = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        
        if (!pageResponse.ok) {
            return res.status(400).json({ 
                error: `Failed to fetch URL (${pageResponse.status})` 
            });
        }
        
        const html = await pageResponse.text();

        /* 3️⃣ Artikel extrahieren */
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            return res.status(400).json({ error: "Kein Artikel erkannt" });
        }

        const text = article.textContent.slice(0, 3000);

        /* 4️⃣ Zusammenfassung (Hugging Face - KORRIGIERT) */
        const hfResponse = await fetch(
    "https://router.huggingface.co/hf-inference/models/facebook/bart-large-cnn",
    {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.HF_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            inputs: text,
            parameters: {
                max_length: 150,
                min_length: 40,
                do_sample: false
            }
        }),
        timeout: 30000
    }
);

        const hfData = await hfResponse.json();

        // Handle Hugging Face errors
        if (!hfResponse.ok) {
            console.error("HF Error:", hfData);
            
            // Fallback 1: Try different model
            try {
                const fallbackResponse = await fetch(
    "https://router.huggingface.co/hf-inference/models/sshleifer/distilbart-cnn-12-6",
    {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.HF_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: text }),
        timeout: 20000
    }
);
                
                if (fallbackResponse.ok) {
                    const fallbackData = await fallbackResponse.json();
                    if (Array.isArray(fallbackData) && fallbackData[0]?.summary_text) {
                        var summary = fallbackData[0].summary_text;
                    }
                }
            } catch (fallbackError) {
                console.error("Fallback also failed:", fallbackError);
            }
            
            // Fallback 2: Simple text truncation
            if (!summary) {
                const sentences = text.split(/[.!?]+/);
                summary = sentences.slice(0, 3).join('. ') + '.';
            }
        } else if (Array.isArray(hfData) && hfData[0]?.summary_text) {
            var summary = hfData[0].summary_text;
        } else if (hfData.summary_text) {
            var summary = hfData.summary_text;
        } else if (hfData[0]?.generated_text) {
            var summary = hfData[0].generated_text;
        } else {
            return res.status(500).json({
                error: "Ungültige Antwort von Summarization API"
            });
        }

        /* 5️⃣ Übersetzung mit FALLBACKS */
        let translatedText;
        
        // TRY 1: LibreTranslate
        try {
            const translateResponse = await fetch(
                "https://libretranslate.com/translate",
                {
                    method: "POST",
                    headers: { 
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify({
                        q: summary,
                        source: "en",
                        target: language,
                        format: "text"
                    }),
                    timeout: 10000
                }
            );

            if (translateResponse.ok) {
                const translateData = await translateResponse.json();
                if (translateData.translatedText) {
                    translatedText = translateData.translatedText;
                }
            }
        } catch (error) {
            console.log("LibreTranslate failed, trying fallback...");
        }

        // TRY 2: MyMemory Translator (Fallback)
        if (!translatedText) {
            try {
                const fallbackResponse = await fetch(
                    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(summary)}&langpair=en|${language}`,
                    { timeout: 10000 }
                );
                
                if (fallbackResponse.ok) {
                    const fallbackData = await fallbackResponse.json();
                    if (fallbackData.responseData?.translatedText) {
                        translatedText = fallbackData.responseData.translatedText;
                    }
                }
            } catch (error) {
                console.log("MyMemory also failed");
            }
        }

        // TRY 3: If all translation fails, return English summary
        if (!translatedText) {
            translatedText = summary;
        }

        /* ✅ Erfolg */
        res.status(200).json({
            title: article.title || "Article",
            summary: translatedText,
            language: language
        });

    } catch (error) {
        console.error("❌ API ERROR:", error);
        
        // User-friendly error messages
        let errorMessage = "Interner Serverfehler";
        if (error.message.includes("fetch failed") || error.message.includes("network")) {
            errorMessage = "Netzwerkfehler. Bitte Internetverbindung prüfen.";
        } else if (error.message.includes("timeout")) {
            errorMessage = "Zeitüberschreitung. Bitte kürzeren Artikel versuchen.";
        }
        
        res.status(500).json({
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
