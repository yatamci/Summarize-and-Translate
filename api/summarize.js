// api/summarize.js
// Optimierte Version mit besserer Zusammenfassung und zuverlässiger Übersetzung

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

/* -------------------- Konfiguration -------------------- */
const MAX_ARTICLE_CHARS = 150000;
const FETCH_TIMEOUT_MS = 20000;
const CHUNK_SIZE = 2000; // Kleinere Chunks für bessere Qualität

// Kostenlose APIs
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

const LANGUAGE_NAMES = {
  de: "Deutsch", en: "English", es: "Español", fr: "Français",
  it: "Italiano", nl: "Nederlands", da: "Dansk", no: "Norsk",
  sv: "Svenska", fi: "Suomi", pl: "Polski", cs: "Čeština", ru: "Русский"
};

/* -------------------- Hilfsfunktionen -------------------- */

// Text gründlich bereinigen
function cleanText(text) {
  if (!text) return "";
  
  let cleaned = text;
  
  // Entferne alle Zitationen und Referenzen
  cleaned = cleaned.replace(/\[\s*\d+(?:[,\s\-–—]*\d+)*\s*\]/g, "");
  cleaned = cleaned.replace(/\[\s*[a-zA-Z]+\s*\]/g, "");
  cleaned = cleaned.replace(/\[\s*cite[^\]]*\]/gi, "");
  cleaned = cleaned.replace(/\(siehe[^)]*\)/gi, "");
  cleaned = cleaned.replace(/\(vgl\.[^)]*\)/gi, "");
  cleaned = cleaned.replace(/\[Bearbeiten\s*\|\s*Quelltext bearbeiten\]/gi, "");
  cleaned = cleaned.replace(/\[edit\]/gi, "");
  cleaned = cleaned.replace(/\^/g, "");
  cleaned = cleaned.replace(/Main article:\s*[^\n]*/gi, "");
  
  // Mehrfache Leerzeichen und Zeilenumbrüche
  cleaned = cleaned.replace(/\s+/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/\s+([.,!?;:])/g, "$1");
  
  return cleaned.trim();
}

// Intelligentes Chunking an Absatzgrenzen
function splitIntoChunks(text, maxLength = CHUNK_SIZE) {
  if (!text || text.length <= maxLength) {
    return [text];
  }
  
  // Splitte zuerst in Absätze
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let currentChunk = "";
  
  for (const para of paragraphs) {
    // Wenn Absatz allein zu groß, splitte in Sätze
    if (para.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const sent of sentences) {
        if ((currentChunk + sent).length <= maxLength) {
          currentChunk += sent;
        } else {
          if (currentChunk) chunks.push(currentChunk.trim());
          currentChunk = sent;
        }
      }
    } else {
      // Normaler Absatz
      if ((currentChunk + "\n\n" + para).length <= maxLength) {
        currentChunk += (currentChunk ? "\n\n" : "") + para;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = para;
      }
    }
  }
  
  if (currentChunk) chunks.push(currentChunk.trim());
  
  return chunks.filter(c => c.length > 0);
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

// Hugging Face API mit verbesserter Fehlerbehandlung
async function callHuggingFace(model, inputs, params = {}, retries = 3) {
  const url = `https://api-inference.huggingface.co/models/${model}`;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: inputs,
          options: { wait_for_model: true, use_cache: false },
          parameters: {
            max_length: params.max_length || 512,
            min_length: params.min_length || 100,
            do_sample: false,
            early_stopping: true,
            no_repeat_ngram_size: 3,
            ...params
          }
        })
      }, 90000); // Längerer Timeout

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        
        if (response.status === 503 && errorText.includes("loading")) {
          console.log(`⏳ Model lädt... Warte 25 Sekunden (${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, 25000));
          continue;
        }
        
        throw new Error(`HF API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Extrahiere Text
      if (Array.isArray(data) && data[0]) {
        return data[0].summary_text || data[0].translation_text || data[0].generated_text || "";
      }
      if (data.summary_text) return data.summary_text;
      if (data.translation_text) return data.translation_text;
      if (data.generated_text) return data.generated_text;
      
      return "";
      
    } catch (error) {
      if (attempt === retries - 1) throw error;
      console.log(`❌ Versuch ${attempt + 1} fehlgeschlagen, versuche erneut...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  throw new Error("Max retries exceeded");
}

// VERBESSERTE Zusammenfassung - Verarbeitet ALLE Chunks vollständig
async function summarizeText(text) {
  console.log(`📝 Starte Zusammenfassung (${text.length} Zeichen)`);
  
  const chunks = splitIntoChunks(text, CHUNK_SIZE);
  console.log(`📊 Aufgeteilt in ${chunks.length} Chunks`);
  
  const summaries = [];
  
  // WICHTIG: Verarbeite ALLE Chunks, nicht nur die ersten
  for (let i = 0; i < chunks.length; i++) {
    console.log(`🔄 Verarbeite Chunk ${i + 1}/${chunks.length} (${chunks[i].length} Zeichen)`);
    
    try {
      const summary = await callHuggingFace(SUMMARIZATION_MODEL, chunks[i], {
        max_length: 300,
        min_length: 80
      });
      
      if (summary && summary.length > 20) {
        summaries.push(summary);
        console.log(`✅ Chunk ${i + 1} zusammengefasst: ${summary.length} Zeichen`);
      }
    } catch (error) {
      console.error(`❌ Fehler bei Chunk ${i + 1}:`, error.message);
      // Fallback: Nimm wichtigste Sätze des Chunks
      const sentences = chunks[i].split(/[.!?]+/).filter(s => s.trim().length > 20);
      const fallback = sentences.slice(0, 4).join(". ") + ".";
      summaries.push(fallback);
    }
  }
  
  console.log(`✅ ${summaries.length} Teil-Zusammenfassungen erstellt`);
  
  // Kombiniere alle Zusammenfassungen zu einem Text
  let combined = summaries.join(" ");
  
  // Falls immer noch zu lang, nochmal zusammenfassen
  if (combined.length > 4000 && summaries.length > 3) {
    console.log("🔄 Kombiniere und komprimiere Zusammenfassungen...");
    try {
      combined = await callHuggingFace(SUMMARIZATION_MODEL, combined, {
        max_length: 600,
        min_length: 200
      });
      console.log(`✅ Finale Zusammenfassung: ${combined.length} Zeichen`);
    } catch (error) {
      console.log("⚠️ Kombinierung fehlgeschlagen, verwende kombinierte Summaries");
    }
  }
  
  return combined;
}

// VERBESSERTE Übersetzung - Chunk-basiert für längere Texte
async function translateText(text, targetLanguage) {
  if (targetLanguage === "en" || !text) {
    return text;
  }
  
  console.log(`🌍 Übersetze nach ${LANGUAGE_NAMES[targetLanguage]} (${text.length} Zeichen)`);
  
  const translationModel = TRANSLATION_MODELS[targetLanguage];
  
  if (!translationModel) {
    console.log(`⚠️ Kein HF Model für ${targetLanguage}, nutze LibreTranslate`);
    return await translateWithLibreTranslate(text, targetLanguage);
  }
  
  try {
    // Teile in kleinere Chunks (1000 Zeichen) für bessere Übersetzung
    const chunks = splitIntoChunks(text, 1000);
    console.log(`📊 Übersetzung in ${chunks.length} Chunks`);
    
    const translations = [];
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`🔄 Übersetze Chunk ${i + 1}/${chunks.length}`);
      
      try {
        const translated = await callHuggingFace(translationModel, chunks[i], {
          max_length: 1500
        });
        
        if (translated && translated.length > 0) {
          translations.push(translated);
          console.log(`✅ Chunk ${i + 1} übersetzt`);
        } else {
          // Fallback für diesen Chunk
          const fallbackTranslation = await translateWithLibreTranslate(chunks[i], targetLanguage);
          translations.push(fallbackTranslation);
        }
      } catch (error) {
        console.error(`❌ Übersetzungs-Fehler Chunk ${i + 1}:`, error.message);
        // Fallback für diesen Chunk
        const fallbackTranslation = await translateWithLibreTranslate(chunks[i], targetLanguage);
        translations.push(fallbackTranslation);
      }
    }
    
    const result = translations.join(" ");
    console.log(`✅ Übersetzung abgeschlossen: ${result.length} Zeichen`);
    return result;
    
  } catch (error) {
    console.error("❌ Gesamt-Übersetzung fehlgeschlagen:", error.message);
    return await translateWithLibreTranslate(text, targetLanguage);
  }
}

// LibreTranslate Fallback mit Chunk-Support
async function translateWithLibreTranslate(text, targetLanguage) {
  console.log("🔄 LibreTranslate Fallback aktiviert");
  
  try {
    // LibreTranslate hat auch Limits, also chunken wir
    if (text.length > 5000) {
      const chunks = splitIntoChunks(text, 4000);
      const translations = [];
      
      for (const chunk of chunks) {
        const response = await fetchWithTimeout("https://libretranslate.com/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: chunk,
            source: "en",
            target: targetLanguage,
            format: "text"
          })
        }, 30000);

        if (response.ok) {
          const data = await response.json();
          translations.push(data.translatedText || chunk);
        } else {
          translations.push(chunk);
        }
        
        // Kleine Pause zwischen Requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return translations.join(" ");
    } else {
      const response = await fetchWithTimeout("https://libretranslate.com/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    }
  } catch (error) {
    console.error("❌ LibreTranslate fehlgeschlagen:", error.message);
    return text;
  }
}

/* -------------------- Haupt-Handler -------------------- */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Nur POST erlaubt" });

  console.log("🚀 === NEUE ANFRAGE ===");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    if (!url) return res.status(400).json({ error: "URL fehlt" });
    if (!language) return res.status(400).json({ error: "Sprache fehlt" });

    console.log(`📝 URL: ${url}`);
    console.log(`🌍 Zielsprache: ${language}`);

    // 1) Webseite laden
    const pageResponse = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!pageResponse.ok) {
      return res.status(400).json({ error: `Webseite antwortet mit ${pageResponse.status}` });
    }

    const html = await pageResponse.text();
    console.log(`✅ HTML geladen: ${html.length} Zeichen`);

    // 2) Artikel extrahieren
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(400).json({ error: "Kein Artikel-Inhalt gefunden" });
    }

    console.log(`📄 Artikel: "${article.title}" (${article.textContent.length} Zeichen)`);

    // 3) Text bereinigen
    let cleanedText = cleanText(article.textContent);
    
    if (cleanedText.length > MAX_ARTICLE_CHARS) {
      console.log(`⚠️ Artikel zu lang, kürze auf ${MAX_ARTICLE_CHARS}`);
      cleanedText = cleanedText.substring(0, MAX_ARTICLE_CHARS);
    }

    console.log(`🧹 Text bereinigt: ${cleanedText.length} Zeichen`);

    // 4) Zusammenfassung erstellen
    const summary = await summarizeText(cleanedText);
    
    if (!summary || summary.length < 50) {
      return res.status(500).json({ error: "Zusammenfassung zu kurz oder leer" });
    }

    console.log(`✅ Zusammenfassung: ${summary.length} Zeichen`);

    // 5) Übersetzen
    let finalText = summary;
    if (language !== "en") {
      finalText = await translateText(summary, language);
      console.log(`✅ Übersetzt: ${finalText.length} Zeichen`);
    }

    // 6) Antwort
    console.log("🎉 === ERFOLGREICH ===");
    
    return res.status(200).json({
      title: article.title || "Artikel",
      summary: finalText,
      language: language,
      originalLength: article.textContent.length,
      cleanedLength: cleanedText.length,
      summaryLength: summary.length,
      translatedLength: finalText.length
    });

  } catch (error) {
    console.error("❌ === FEHLER ===", error);
    return res.status(500).json({ 
      error: "Interner Fehler",
      details: error.message 
    });
  }
}
