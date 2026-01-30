// api/summarize.js
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

/**
 * Konfiguration
 */
const HF_API_KEY = process.env.HF_API_KEY; // setze in Vercel
const HF_MODEL = process.env.HF_MODEL || "facebook/bart-large-cnn";
const MAX_CHUNK_CHARS = 28000; // konservative Chunk-Größe
const FETCH_TIMEOUT_MS = 20000;

/**
 * Hilfsfunktionen
 */
function splitIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^\.!\?]+[\.!\?]+(\s|$)/g) || [text];
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = s;
      } else {
        // einzelner Satz länger als maxChars -> harte Trennung
        let start = 0;
        while (start < s.length) {
          chunks.push(s.slice(start, start + maxChars));
          start += maxChars;
        }
        current = "";
      }
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

async function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function callHfRouter(model, inputText, parameters = {}) {
  if (!HF_API_KEY) throw new Error("HF_API_KEY is not set in environment variables.");

  const url = `https://router.huggingface.co/api/models/${encodeURIComponent(model)}`;
  const body = {
    inputs: inputText,
    parameters: Object.keys(parameters).length ? parameters : undefined,
    options: { wait_for_model: true }
  };

  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${HF_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, 30000);

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HF Router ${resp.status}: ${txt}`);
  }

  const data = await resp.json().catch(() => null);
  if (!data) return "";

  if (typeof data === "string") return data;
  if (Array.isArray(data) && data[0]?.summary_text) return data[0].summary_text;
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
  if (data.summary_text) return data.summary_text;
  if (data.generated_text) return data.generated_text;
  // fallback stringify
  return Array.isArray(data) ? JSON.stringify(data[0]) : JSON.stringify(data);
}

/**
 * Handler
 */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    if (!url || !language) return res.status(400).json({ error: "Missing parameters" });

    // 1) Hole Seite (mit Timeout)
    const pageResp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, 15000);

    if (!pageResp.ok) return res.status(400).json({ error: `Failed to fetch URL (${pageResp.status})` });
    const html = await pageResp.text();

    // 2) Extract article with Readability
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) return res.status(400).json({ error: "Kein Artikel erkannt" });

    // 3) Chunking (verhindert zu große Requests)
    const fullText = article.textContent.replace(/\s+/g, ' ').trim();
    const chunks = splitIntoChunks(fullText);

    // 4) Summarize each chunk via HF Router
    const summaries = [];
    for (const chunk of chunks) {
      // prompt: kurz und klar
      const prompt = `Summarize the following text concisely in English:\n\n${chunk}`;
      try {
        const s = await callHfRouter(HF_MODEL, prompt, { max_new_tokens: 300, temperature: 0.2 });
        summaries.push(typeof s === "string" ? s : String(s));
      } catch (err) {
        console.error("HF chunk error:", err.message || err);
        // fallback: take first 3 sentences of chunk
        const sentences = chunk.split(/[.!?]+/).filter(Boolean);
        summaries.push(sentences.slice(0, 3).join('. ') + '.');
      }
    }

    // 5) Combine summaries and condense
    const combined = summaries.join("\n\n");
    let finalSummary;
    try {
      const combinePrompt = `Combine and condense the following summaries into one concise summary in English:\n\n${combined}`;
      finalSummary = await callHfRouter(HF_MODEL, combinePrompt, { max_new_tokens: 400, temperature: 0.2 });
    } catch (err) {
      console.error("HF combine error:", err.message || err);
      // fallback: join first 3 summary sentences
      const sents = combined.split(/[.!?]+/).filter(Boolean);
      finalSummary = sents.slice(0, 6).join('. ') + '.';
    }

    // 6) Übersetzung: zuerst LibreTranslate (POST), falls fehlschlägt, gebe englischen Text zurück
    let translatedText = null;
    try {
      const ltResp = await fetchWithTimeout("https://libretranslate.com/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          q: finalSummary,
          source: "en",
          target: language,
          format: "text"
        })
      }, 10000);

      if (ltResp.ok) {
        const ltData = await ltResp.json().catch(() => null);
        if (ltData?.translatedText) translatedText = ltData.translatedText;
      }
    } catch (err) {
      console.log("LibreTranslate failed:", err.message || err);
    }

    if (!translatedText) translatedText = finalSummary;

    return res.status(200).json({
      title: article.title || "Article",
      summary: translatedText,
      language
    });

  } catch (error) {
    console.error("❌ API ERROR:", error);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
