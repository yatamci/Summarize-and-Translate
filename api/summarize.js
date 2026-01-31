// api/summarize.js
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const MAX_ARTICLE_CHARS = 200000;
const TIMEOUT = 25000;

// Bessere Modelle
const SUMMARIZATION_MODEL = "sshleifer/distilbart-cnn-12-6"; // Schneller & zuverlässiger
const TRANSLATION_MODELS = {
  de: "Helsinki-NLP/opus-mt-en-de",
  es: "Helsinki-NLP/opus-mt-en-es",
  fr: "Helsinki-NLP/opus-mt-en-fr",
  it: "Helsinki-NLP/opus-mt-en-it",
  nl: "Helsinki-NLP/opus-mt-en-nl",
  fi: "Helsinki-NLP/opus-mt-en-fi",
  sv: "Helsinki-NLP/opus-mt-en-sv",
  pl: "Helsinki-NLP/opus-mt-en-pl",
  cs: "Helsinki-NLP/opus-mt-en-cs",
  ru: "Helsinki-NLP/opus-mt-en-ru",
  no: "Helsinki-NLP/opus-mt-en-no",
  da: "Helsinki-NLP/opus-mt-en-da"
};

// Text bereinigen
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\[\s*\d+(?:[,\s\-–—]*\d+)*\s*\]/g, "")
    .replace(/\[\s*[a-zA-Z]+\s*\]/g, "")
    .replace(/\[\s*cite[^\]]*\]/gi, "")
    .replace(/\(siehe[^)]*\)/gi, "")
    .replace(/\[Bearbeiten[^\]]*\]/gi, "")
    .replace(/\[edit\]/gi, "")
    .replace(/\^/g, "")
    .replace(/Main article:\s*[^\n]*/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

// Intelligentes Chunking
function chunkText(text, maxSize = 1500) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = "";
  
  for (const sentence of sentences) {
    if ((current + sentence).length > maxSize) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current.trim());
  
  return chunks;
}

// Fetch mit Timeout
async function fetchWithTimeout(url, options, timeout = TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Hugging Face API Call
async function callHF(model, text, maxRetries = 3) {
  const url = `https://api-inference.huggingface.co/models/${model}`;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: text,
          options: { wait_for_model: true },
          parameters: {
            max_length: 512,
            min_length: 50,
            do_sample: false
          }
        })
      }, 90000);

      if (response.status === 503) {
        console.log(`Model lädt... Warte 30s (${i+1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // Extrahiere Text aus Response
      if (Array.isArray(data) && data[0]) {
        return data[0].summary_text || data[0].translation_text || data[0].generated_text || "";
      }
      return data.summary_text || data.translation_text || data.generated_text || "";
      
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.log(`Retry ${i+1}...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// NEUE Strategie: Extraktive Zusammenfassung (nimm wichtigste Sätze)
function extractiveSummary(text, maxSentences = 15) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  // Bewerte Sätze nach Wichtigkeit (einfache Heuristik)
  const scored = sentences.map((sent, idx) => {
    let score = 0;
    
    // Erste Sätze sind wichtiger
    if (idx < 5) score += 3;
    
    // Längere Sätze (nicht zu kurz, nicht zu lang)
    const len = sent.trim().length;
    if (len > 50 && len < 200) score += 2;
    
    // Enthält Schlüsselwörter
    const keywords = ['ist', 'sind', 'wird', 'wurde', 'kann', 'hat', 'haben', 
                      'wichtig', 'bedeutend', 'haupt', 'erste', 'größte'];
    keywords.forEach(kw => {
      if (sent.toLowerCase().includes(kw)) score += 1;
    });
    
    return { text: sent.trim(), score };
  });
  
  // Sortiere nach Score, nimm Top N
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .map(s => s.text)
    .join(" ");
}

// Zusammenfassung mit Hybrid-Ansatz
async function summarizeText(text) {
  console.log(`📝 Starte Zusammenfassung (${text.length} Zeichen)`);
  
  // Strategie 1: Für kurze Texte - direkt mit HF
  if (text.length < 3000) {
    try {
      const result = await callHF(SUMMARIZATION_MODEL, text);
      if (result && result.length > 100) {
        console.log(`✅ Direkte Zusammenfassung: ${result.length} Zeichen`);
        return result;
      }
    } catch (err) {
      console.log("⚠️ HF fehlgeschlagen, nutze extraktiv");
    }
  }
  
  // Strategie 2: Für lange Texte - erst extraktiv verkürzen, dann HF
  console.log("📊 Nutze Hybrid-Ansatz");
  
  // Schritt 1: Extraktive Zusammenfassung (wichtigste Sätze)
  const extractive = extractiveSummary(text, 20);
  console.log(`✅ Extraktiv: ${extractive.length} Zeichen`);
  
  // Schritt 2: Diese verkürzte Version durch HF jagen
  try {
    const abstractive = await callHF(SUMMARIZATION_MODEL, extractive);
    if (abstractive && abstractive.length > 50) {
      console.log(`✅ Abstraktiv: ${abstractive.length} Zeichen`);
      return abstractive;
    }
  } catch (err) {
    console.log("⚠️ Abstraktiv fehlgeschlagen, nutze extraktiv");
  }
  
  // Fallback: Gib extraktive Zusammenfassung zurück
  return extractive;
}

// Verbesserte Übersetzung
async function translateText(text, lang) {
  if (lang === "en" || !text) return text;
  
  console.log(`🌍 Übersetze nach ${lang}`);
  
  const model = TRANSLATION_MODELS[lang];
  if (!model) {
    console.log("⚠️ Kein HF Model, nutze LibreTranslate");
    return await translateLibre(text, lang);
  }
  
  // Chunk-basierte Übersetzung
  const chunks = chunkText(text, 800);
  console.log(`📊 ${chunks.length} Übersetzungs-Chunks`);
  
  const translated = [];
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await callHF(model, chunks[i]);
      if (result) {
        translated.push(result);
        console.log(`✅ Chunk ${i+1}/${chunks.length} übersetzt`);
      } else {
        // Fallback zu LibreTranslate für diesen Chunk
        const libre = await translateLibre(chunks[i], lang);
        translated.push(libre);
      }
    } catch (err) {
      console.log(`❌ Chunk ${i+1} HF fehlgeschlagen, nutze LibreTranslate`);
      const libre = await translateLibre(chunks[i], lang);
      translated.push(libre);
    }
    
    // Kleine Pause zwischen Chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  return translated.join(" ");
}

// LibreTranslate Fallback
async function translateLibre(text, lang) {
  try {
    const res = await fetchWithTimeout("https://libretranslate.com/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source: "en",
        target: lang,
        format: "text"
      })
    }, 30000);
    
    if (res.ok) {
      const data = await res.json();
      return data.translatedText || text;
    }
  } catch (err) {
    console.log("LibreTranslate Fehler:", err.message);
  }
  return text;
}

// Haupt-Handler
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Nur POST" });

  console.log("🚀 === START ===");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    if (!url) return res.status(400).json({ error: "URL fehlt" });
    if (!language) return res.status(400).json({ error: "Sprache fehlt" });

    console.log(`📝 URL: ${url}`);
    console.log(`🌍 Sprache: ${language}`);

    // 1) Webseite laden
    const pageRes = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!pageRes.ok) {
      return res.status(400).json({ error: `Status ${pageRes.status}` });
    }

    const html = await pageRes.text();
    console.log(`✅ HTML: ${html.length} Zeichen`);

    // 2) Artikel extrahieren
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.textContent) {
      return res.status(400).json({ error: "Kein Artikel gefunden" });
    }

    console.log(`📄 Artikel: "${article.title}" (${article.textContent.length} Zeichen)`);

    // 3) Bereinigen
    let cleaned = cleanText(article.textContent);
    if (cleaned.length > MAX_ARTICLE_CHARS) {
      cleaned = cleaned.substring(0, MAX_ARTICLE_CHARS);
    }
    console.log(`🧹 Bereinigt: ${cleaned.length} Zeichen`);

    // 4) Zusammenfassen
    const summary = await summarizeText(cleaned);
    if (!summary || summary.length < 30) {
      return res.status(500).json({ error: "Zusammenfassung fehlgeschlagen" });
    }
    console.log(`✅ Zusammenfassung: ${summary.length} Zeichen`);

    // 5) Übersetzen
    let final = summary;
    if (language !== "en") {
      final = await translateText(summary, language);
      console.log(`✅ Übersetzt: ${final.length} Zeichen`);
    }

    console.log("🎉 === ERFOLG ===");

    return res.status(200).json({
      title: article.title || "Artikel",
      summary: final,
      language: language,
      originalLength: article.textContent.length,
      cleanedLength: cleaned.length,
      summaryLength: summary.length,
      translatedLength: final.length
    });

  } catch (error) {
    console.error("❌ FEHLER:", error);
    return res.status(500).json({ 
      error: "Interner Fehler",
      details: error.message 
    });
  }
}
