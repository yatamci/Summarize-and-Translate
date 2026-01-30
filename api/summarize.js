import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        /* 1️⃣ Body sicher parsen */
        const body = typeof req.body === "string"
            ? JSON.parse(req.body)
            : req.body;

        const { url, language } = body;

        if (!url || !language) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        /* 2️⃣ Webseite laden */
        const pageResponse = await fetch(url);
        const html = await pageResponse.text();

        /* 3️⃣ Artikel extrahieren */
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            return res.status(400).json({ error: "Kein Artikel erkannt" });
        }

        const text = article.textContent.slice(0, 2500);

        /* 4️⃣ Zusammenfassung (Hugging Face) */
        const hfResponse = await fetch(
            "https://api-inference.huggingface.co/models/facebook/bart-large-cnn",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.HF_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ inputs: text })
            }
        );

        const hfData = await hfResponse.json();

        if (hfData.error) {
            return res.status(503).json({
                error: "HuggingFace Fehler",
                details: hfData.error
            });
        }

        if (!Array.isArray(hfData) || !hfData[0]?.summary_text) {
            return res.status(500).json({
                error: "Ungültige Antwort von HuggingFace"
            });
        }

        const summary = hfData[0].summary_text;

        /* 5️⃣ Übersetzung */
        const translateResponse = await fetch(
            "https://libretranslate.com/translate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    q: summary,
                    source: "auto",
                    target: language,
                    format: "text"
                })
            }
        );

        const translateData = await translateResponse.json();

        if (!translateData.translatedText) {
            return res.status(500).json({
                error: "Übersetzung fehlgeschlagen"
            });
        }

        /* ✅ Erfolg */
        res.status(200).json({
            title: article.title,
            summary: translateData.translatedText
        });

    } catch (error) {
        console.error("❌ API ERROR:", error);
        res.status(500).json({
            error: "Interner Serverfehler",
            details: error.message
        });
    }
}
