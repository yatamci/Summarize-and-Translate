// api/summarize.js
// Vollständiger, robuster Handler für Zusammenfassung + optionale Übersetzung.
// Voraussetzungen: setze in Vercel die Environment Variable HF_API_KEY (und optional HF_MODEL).

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

/* -------------------- Konfiguration -------------------- */
const HF_API_KEY = process.env.HF_API_KEY; // in Vercel setzen
const HF_MODEL = process.env.HF_MODEL || "facebook/bart-large-cnn";
const MAX_CHUNK_CHARS = 28000; // konservative Chunk-Größe
const MAX_TOTAL_CHARS = 200000; // maximale Gesamtlänge des Artikels, um extremes Verhalten zu vermeiden
const FETCH_TIMEOUT_MS = 20000;

/* -------------------- Hilfsfunktionen -------------------- */

// Splitte Text in sinnvolle Chunks (versucht Satzgrenzen zu respektieren)
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

// Entfernt Fußnoten, Referenzmarker und bereinigt Whitespace
function cleanExtractedText(s) {
  if (!s) return "";
  let t = s;
  // Entferne eckige Referenzen wie [1], [2][3], [a]
  t = t.replace(/\[\s*\d+(?:[,\s]*\d+)*\s*\]/g, " ");
  t = t.replace(/\[[a-zA-Z]\]/g, " ");
  // Entferne typische Wikipedia‑Referenzen wie [393]
  t = t.replace(/\[\d+\]/g, " ");
  // Entferne Klammerinhalte mit "siehe" oder "vgl." (optional)
  t = t.replace(/`\(siehe[^\)`]*\)/gi, " ");
  // Entferne multiple Leerzeichen und Zeilenumbrüche
  t = t.replace(/\s+/g, " ").trim();
  // Entferne isolierte, kaputte Satzfragmente wie 'S.' oder 'S. S.'
  t = t.replace(/\bS\.\s*/g, "");
  return t;
}

// Kleine Nachbearbeitung für bessere Lesbarkeit
function tidySummary(text) {
  if (!text) return "";
  let t = text;
  t = t.replace(/\s+([.,!?;:])/g, "$1"); // space before punctuation
  t = t.replace(/([.,!?;:]){2,}/g, "$1"); // duplicate punctuation
  t = t.replace(/\s{2,}/g, " ");
  t = t.replace(/\n{2,}/g, "\n\n");
  t = t.replace(/^[\s\.\,\-]+/, "").replace(/[\s\.\,\-]+$/, "");
  return t.trim();
}

// Normalisiere Benutzersprache auf Code + Name
function normalizeLanguageCode(lang) {
  if (!lang) return { code: "en", name: "English" };
  const l = String(lang).toLowerCase();
  if (["de", "deu", "german", "deutsch"].includes(l)) return { code: "de", name: "German" };
  if (["en", "eng", "english"].includes(l)) return { code: "en", name: "English" };
  if (["fr", "fra", "french", "français"].includes(l)) return { code: "fr", name: "French" };
  if (["es", "spa", "spanish", "español"].includes(l)) return { code: "es", name: "Spanish" };
  // Fallback: code = first two chars
  return { code: l.slice(0, 2), name: l.charAt(0).toUpperCase() + l.slice(1) };
}

// Fetch mit AbortController / Timeout
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

// Aufruf des Hugging Face Router Endpoints (POST JSON im Body)
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
  return Array.isArray(data) ? JSON.stringify(data[0]) : JSON.stringify(data);
}

/* -------------------- Haupt-Handler -------------------- */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    if (!url || !language) return res.status(400).json({ error: "Missing parameters: url and language required" });

    // 1) Seite holen
    let pageResp;
    try {
      pageResp = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      }, 15000);
    } catch (err) {
      console.error("Fetch page error:", err.message || err);
      return res.status(502).json({ error: "Failed to fetch URL" });
    }

    if (!pageResp.ok) return res.status(400).json({ error: `Failed to fetch URL (${pageResp.status})` });
    const html = await pageResp.text();

    // 2) Artikel extrahieren
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) return res.status(400).json({ error: "No article content detected" });

    // 3) Text bereinigen und ggf. truncaten
    const rawText = article.textContent || "";
    const cleaned = cleanExtractedText(rawText);
    const truncated = cleaned.length > MAX_TOTAL_CHARS ? cleaned.slice(0, MAX_TOTAL_CHARS) : cleaned;

    // 4) Chunking
    const chunks = splitIntoChunks(truncated);

    // 5) Summarize each chunk directly in requested language
    const langInfo = normalizeLanguageCode(language);
    const summaries = [];

    for (const chunk of chunks) {
      const prompt = `Please produce a clear, well-structured summary in ${langInfo.name}. ` +
                     `Write in complete sentences and group related points into short paragraphs. ` +
                     `Keep it concise but informative (about 3-6 sentences). ` +
                     `Do not include citations, bracketed references, or footnotes. ` +
                     `Text to summarize:\n\n${chunk}`;

      try {
        const s = await callHfRouter(HF_MODEL, prompt, { max_new_tokens: 350, temperature: 0.2 });
        summaries.push(typeof s === "string" ? s : String(s));
      } catch (err) {
        console.error("HF chunk error:", err.message || err);
        // Fallback: erste 4 Sätze des Chunks
        const sentences = chunk.split(/[.!?]+/).filter(Boolean);
        summaries.push(sentences.slice(0, 4).join(". ") + ".");
      }
    }

    // 6) Combine / condense
    const combined = summaries.join("\n\n");
    let finalSummary;
    try {
      const combinePrompt = `Combine and condense the following summaries into one coherent, readable summary in ${langInfo.name}. ` +
                            `Use short paragraphs and clear transitions. Avoid lists, citations, or bracketed references. ` +
                            `Target length: about 6-10 sentences.\n\n${combined}`;
      finalSummary = await callHfRouter(HF_MODEL, combinePrompt, { max_new_tokens: 500, temperature: 0.2 });
    } catch (err) {
      console.error("HF combine error:", err.message || err);
      const sents = combined.split(/[.!?]+/).filter(Boolean);
      finalSummary = sents.slice(0, 10).join(". ") + ".";
    }

    finalSummary = tidySummary(finalSummary);

    // 7) Falls das Modell wider Erwarten in Englisch geliefert hat und user eine andere Sprache wünscht,
    //    führe eine Übersetzung per LibreTranslate (POST) als Fallback durch.
    let translatedText = finalSummary;
    if (langInfo.code !== "en") {
      try {
        const ltResp = await fetchWithTimeout("https://libretranslate.com/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            q: finalSummary,
            source: "en",
            target: langInfo.code,
            format: "text"
          })
        }, 10000);

        if (ltResp.ok) {
          const ltData = await ltResp.json().catch(() => null);
          if (ltData?.translatedText) translatedText = ltData.translatedText;
        }
      } catch (err) {
        console.log("LibreTranslate fallback failed:", err.message || err);
        // keep finalSummary as-is
      }
    }

    // 8) Antwort
    return res.status(200).json({
      title: article.title || "Article",
      summary: translatedText,
      language: langInfo.code
    });

  } catch (error) {
    console.error("❌ API ERROR:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
