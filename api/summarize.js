import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const body = typeof req.body === "string"
    ? JSON.parse(req.body)
    : req.body;

const { url, language } = body;

    if (!url || !language) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    try {
        /* 1. Webseite laden */
        const pageResponse = await fetch(url);
        const html = await pageResponse.text();

        /* 2. Artikel extrahieren */
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            throw new Error("Kein Artikel erkannt");
        }

        /* 3. Zusammenfassung (HuggingFace) */
        const hfResponse = await fetch(
            "https://api-inference.huggingface.co/models/facebook/bart-large-cnn",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.HF_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    inputs: article.textContent.slice(0, 2500)
                })
            }
        );

        const hfData = await hfResponse.json();
        const summary = hfData[0]?.summary_text;

        if (!summary) {
            throw new Error("Zusammenfassung fehlgeschlagen");
        }

        /* 4. Übersetzung (LibreTranslate) */
        const translateResponse = await fetch("https://libretranslate.de/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                q: summary,
                source: "auto",
                target: language,
                format: "text"
            })
        });

        const translateData = await translateResponse.json();

        res.status(200).json({
            title: article.title,
            summary: translateData.translatedText
        });

    } catch (error) {
    console.error("❌ API ERROR:", error);

    res.status(500).json({
        error: "Verarbeitung fehlgeschlagen",
        details: error.message || String(error)
    });
}
}
