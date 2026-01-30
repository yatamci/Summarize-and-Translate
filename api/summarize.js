// api/summarize.js
// Optimierter Handler für Zusammenfassung + Übersetzung mit 100% KOSTENLOSEN APIs
// Verwendet: Hugging Face Inference API (kostenlos, kein API Key nötig)

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

/* -------------------- Konfiguration -------------------- */
const MAX_ARTICLE_CHARS = 100000; // Max Artikel-Länge
const FETCH_TIMEOUT_MS = 15000;
const MAX_CHUNK_LENGTH = 3000; // Chunk-Größe für bessere Verarbeitung

// Kostenlose Hugging Face Models (ohne API Key nutzbar)
const SUMMARIZATION_MODEL = "facebook/bart-large-cnn";
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

/* -------------------- Hilfsfunktionen -------------------- */

// Sprachcode normalisieren
const LANGUAGE_MAP = {
  de: "Deutsch",
  en: "English", 
  es: "Español",
  fr: "Français",
  it: "Italiano",
  nl: "Nederlands",
  da: "Dansk",
  no: "Norsk",
  sv: "Svenska",
  is: "Íslenska",
  fi: "Suomi",
  pl: "Polski",
  cs: "Čeština",
  ru: "Русский",
  lb: "Lëtzebuergesch",
  eo: "Esperanto",
  ia: "Interlingua",
  tok: "Toki Pona"
};

function getLanguageName(code) {
  return LANGUAGE_MAP[code] || LANGUAGE_MAP.en;
}

// Text gründlich bereinigen
function cleanText(text) {
  if (!text) return "";
  
  let cleaned = text;
  
  // Entferne alle Arten von Zitationen und Referenzen
  cleaned = cleaned.replace(/\[\s*\d+(?:[,\s\-–—]*\d+)*\s*\]/g, ""); // [1], [2], [1-3], [1,2,3]
  cleaned = cleaned.replace(/\[\s*[a-zA-Z]+\s*\]/g, ""); // [a], [abc]
  cleaned = cleaned.replace(/\[\s*cite[^\]]*\]/gi, ""); // [cite...], [citation needed]
  cleaned = cleaned.replace(/\(siehe[^)]*\)/gi, ""); // (siehe ...)
  cleaned = cleaned.replace(/\(vgl\.[^)]*\)/gi, ""); // (vgl. ...)
  
  // Entferne Wikipedia-spezifische Elemente
  cleaned = cleaned.replace(/\[Bearbeiten\s*\|\s*Quelltext bearbeiten\]/gi, "");
  cleaned = cleaned.replace(/\[edit\]/gi, "");
  cleaned = cleaned.replace(/\^/g, ""); // Hochgestellte Referenzmarker
  
  // Entferne "Main article:" Links
  cleaned = cleaned.replace(/Main article:\s*[^\n]*/gi, "");
  
  // Entferne mehrfache Leerzeichen und Zeilenumbrüche
  cleaned = cleaned.replace(/\s+/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  
  // Entferne Leerzeichen vor Satzzeichen
  cleaned = cleaned.replace(/\s+([.,!?;:])/g, "$1");
  
  // Entferne isolierte Buchstaben und Fragmente
  cleaned = cleaned.replace(/\b[A-Z]\.\s*/g, "");
  
  return cleaned.trim();
}

// Text in sinnvolle Chunks aufteilen (an Satzgrenzen)
function splitIntoChunks(text, maxLength = MAX_CHUNK_LENGTH) {
  if (!text || text.length <= maxLength) {
    return [text];
  }
  
  // Splitte in Sätze
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = "";
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= maxLength) {
      currentChunk += sentence;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Fetch mit Timeout
async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Hugging Face Inference API aufrufen (kostenlos, kein API Key)
async function callHuggingFace(model, inputs, retries = 3) {
  const url = `https://api-inference.huggingface.co/models/${model}`;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputs: inputs,
          options: { 
            wait_for_model: true,
            use_cache: false
          },
          parameters: {
            max_length: 500,
            min_length: 50,
            do_sample: false,
            early_stopping: true
          }
        })
      }, 60000); // 60 Sekunden Timeout für Model Loading

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        
        // Wenn Model lädt, warte und versuche erneut
        if (response.status === 503 && errorText.includes("loading")) {
          console.log(`⏳ Model wird geladen, warte 20 Sekunden... (Versuch ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, 20000));
          continue;
        }
        
        throw new Error(`HF API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Extrahiere Text aus verschiedenen Response-Formaten
      if (Array.isArray(data) && data[0]) {
        return data[0].summary_text || data[0].translation_text || data[0].generated_text || "";
      }
      if (data.summary_text) return data.summary_text;
      if (data.translation_text) return data.translation_text;
      if (data.generated_text) return data.generated_text;
      
      return "";
      
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }
      console.log(`❌ Fehler bei Versuch ${attempt + 1}, versuche erneut...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  throw new Error("Max retries exceeded");
}

// Zusammenfassung mit mehreren Chunks kombinieren
async function summarizeText(text) {
  console.log(`📝 Starte Zusammenfassung (${text.length} Zeichen)`);
  
  const chunks = splitIntoChunks(text, MAX_CHUNK_LENGTH);
  console.log(`📊 Aufgeteilt in ${chunks.length} Chunks`);
  
  const summaries = [];
  
  // Jeder Chunk wird zusammengefasst
  for (let i = 0; i < chunks.length; i++) {
    console.log(`🔄 Verarbeite Chunk ${i + 1}/${chunks.length}`);
    try {
      const summary = await callHuggingFace(SUMMARIZATION_MODEL, chunks[i]);
      if (summary) {
        summaries.push(summary);
      }
    } catch (error) {
      console.error(`❌ Fehler bei Chunk ${i + 1}:`, error.message);
      // Fallback: Nimm erste 3 Sätze des Chunks
      const sentences = chunks[i].split(/[.!?]+/).filter(s => s.trim());
      summaries.push(sentences.slice(0, 3).join(". ") + ".");
    }
  }
  
  // Kombiniere alle Zusammenfassungen
  let combined = summaries.join(" ");
  
  // Falls kombinierte Zusammenfassung noch zu lang, nochmal zusammenfassen
  if (combined.length > MAX_CHUNK_LENGTH && summaries.length > 1) {
    console.log("🔄 Kombiniere Teil-Zusammenfassungen...");
    try {
      combined = await callHuggingFace(SUMMARIZATION_MODEL, combined);
    } catch (error) {
      console.log("⚠️ Fehler beim Kombinieren, verwende Original");
    }
  }
  
  return combined;
}

// Text übersetzen
async function translateText(text, targetLanguage) {
  if (targetLanguage === "en" || !text) {
    return text; // Kein Translation nötig für Englisch
  }
  
  const translationModel = TRANSLATION_MODELS[targetLanguage];
  
  if (!translationModel) {
    console.log(`⚠️ Keine direkte Übersetzung für ${targetLanguage}, verwende LibreTranslate`);
    return await translateWithLibreTranslate(text, targetLanguage);
  }
  
  console.log(`🌍 Übersetze nach ${getLanguageName(targetLanguage)}`);
  
  try {
    // Teile langen Text in kleinere Abschnitte
    const chunks = splitIntoChunks(text, 1000);
    const translations = [];
    
    for (const chunk of chunks) {
      const translated = await callHuggingFace(translationModel, chunk);
      translations.push(translated);
    }
    
    return translations.join(" ");
    
  } catch (error) {
    console.error("❌ Übersetzung fehlgeschlagen:", error.message);
    // Fallback zu LibreTranslate
    return await translateWithLibreTranslate(text, targetLanguage);
  }
}

// Fallback: LibreTranslate (komplett kostenlos, kein API Key)
async function translateWithLibreTranslate(text, targetLanguage) {
  console.log("🔄 Verwende LibreTranslate als Fallback");
  
  try {
    const response = await fetchWithTimeout("https://libretranslate.com/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: text,
        source: "en",
        target: targetLanguage,
        format: "text"
      })
    }, 30000);

    if (!response.ok) {
      throw new Error(`LibreTranslate Error: ${response.status}`);
    }

    const data = await response.json();
    return data.translatedText || text;
    
  } catch (error) {
    console.error("❌ LibreTranslate fehlgeschlagen:", error.message);
    return text; // Gib Original zurück als letzte Option
  }
}

/* -------------------- Haupt-Handler -------------------- */
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST-Anfragen erlaubt" });
  }

  console.log("🚀 Neue Anfrage erhalten");

  try {
    // Request Body parsen
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    // Validierung
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL fehlt oder ist ungültig" });
    }

    if (!language || !LANGUAGE_MAP[language]) {
      return res.status(400).json({ error: "Sprache fehlt oder wird nicht unterstützt" });
    }

    console.log(`📝 Verarbeite: ${url} → ${language}`);

    // 1) Webseite laden
    let pageResponse;
    try {
      pageResponse = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"
        }
      });
    } catch (error) {
      console.error("❌ Fehler beim Laden der Seite:", error.message);
      return res.status(502).json({ 
        error: "Die Webseite konnte nicht geladen werden",
        details: error.message 
      });
    }

    if (!pageResponse.ok) {
      return res.status(400).json({ 
        error: `Webseite antwortet mit Status ${pageResponse.status}` 
      });
    }

    const html = await pageResponse.text();

    // 2) Artikel extrahieren mit Readability
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(400).json({ 
        error: "Kein Artikel-Inhalt gefunden. Stelle sicher, dass die URL einen lesbaren Artikel enthält." 
      });
    }

    console.log(`📄 Artikel gefunden: "${article.title}" (${article.textContent.length} Zeichen)`);

    // 3) Text gründlich bereinigen
    let cleanedText = cleanText(article.textContent);
    
    // Text kürzen falls zu lang
    if (cleanedText.length > MAX_ARTICLE_CHARS) {
      console.log(`⚠️ Artikel zu lang (${cleanedText.length} Zeichen), kürze auf ${MAX_ARTICLE_CHARS}`);
      cleanedText = cleanedText.substring(0, MAX_ARTICLE_CHARS);
    }

    console.log(`🧹 Text bereinigt: ${cleanedText.length} Zeichen`);

    // 4) Zusammenfassung erstellen
    let summary;
    try {
      summary = await summarizeText(cleanedText);
    } catch (error) {
      console.error("❌ Zusammenfassung fehlgeschlagen:", error.message);
      return res.status(500).json({
        error: "Zusammenfassung konnte nicht erstellt werden",
        details: error.message
      });
    }

    if (!summary) {
      return res.status(500).json({
        error: "Leere Zusammenfassung erhalten"
      });
    }

    console.log(`✅ Zusammenfassung erstellt: ${summary.length} Zeichen`);

    // 5) Übersetzen falls nötig
    let finalText = summary;
    if (language !== "en") {
      try {
        finalText = await translateText(summary, language);
        console.log(`✅ Übersetzung abgeschlossen`);
      } catch (error) {
        console.error("❌ Übersetzung fehlgeschlagen:", error.message);
        // Gib englische Zusammenfassung zurück wenn Übersetzung fehlschlägt
        finalText = summary;
      }
    }

    // 6) Erfolgreiche Antwort
    return res.status(200).json({
      title: article.title || "Artikel",
      summary: finalText,
      language: language,
      originalLength: article.textContent.length,
      cleanedLength: cleanedText.length,
      summaryLength: summary.length
    });

  } catch (error) {
    console.error("❌ Unerwarteter Fehler:", error);
    
    return res.status(500).json({ 
      error: "Ein interner Fehler ist aufgetreten",
      details: error.message 
    });
  }
}
