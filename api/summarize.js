// api/summarize.js - OPTIMIERT FÜR VERCEL FREE PLAN (10 Sekunden Timeout)
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const TIMEOUT = 8000; // 8 Sekunden max pro Request
const MAX_TEXT_LENGTH = 100000;

/* -------------------- Text-Bereinigung -------------------- */
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\[\s*\d+(?:[,\s\-–—]*\d+)*\s*\]/g, "") // [1], [2], [1-3]
    .replace(/\[\s*[a-zA-Z]+\s*\]/g, "") // [a], [abc]
    .replace(/\[\s*cite[^\]]*\]/gi, "") // [cite needed]
    .replace(/\(siehe[^)]*\)/gi, "") // (siehe...)
    .replace(/\(vgl\.[^)]*\)/gi, "") // (vgl....)
    .replace(/\[Bearbeiten[^\]]*\]/gi, "") // [Bearbeiten | Quelltext]
    .replace(/\[edit\]/gi, "") // [edit]
    .replace(/\^/g, "") // Hochgestellte Ziffern
    .replace(/Main article:\s*[^\n]*/gi, "") // Main article: ...
    .replace(/\s+/g, " ") // Mehrfache Leerzeichen
    .replace(/\s+([.,!?;:])/g, "$1") // Leerzeichen vor Satzzeichen
    .trim();
}

/* -------------------- SCHNELLE Extraktive Zusammenfassung -------------------- */
// Keine API! Sofort fertig! Wählt die wichtigsten Sätze aus.
function extractiveSummary(text, targetSentences = 15) {
  // Splitte in Sätze
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  if (sentences.length === 0) return text.substring(0, 500);
  if (sentences.length <= targetSentences) return sentences.join(" ");
  
  // Bewerte jeden Satz nach Wichtigkeit
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    const sent = sentence.trim();
    const len = sent.length;
    
    // 1. Position im Text (Anfang ist wichtiger)
    if (index < 3) score += 5;
    else if (index < 10) score += 3;
    else if (index < 20) score += 1;
    
    // 2. Satzlänge (nicht zu kurz, nicht zu lang)
    if (len > 40 && len < 200) score += 3;
    else if (len > 20 && len < 300) score += 1;
    
    // 3. Enthält wichtige Schlüsselwörter
    const keywords = [
      'ist', 'sind', 'war', 'waren', 'wird', 'wurde', 'wurden',
      'hat', 'haben', 'hatte', 'kann', 'konnte', 'muss',
      'wichtig', 'bedeutend', 'hauptsächlich', 'besonders',
      'erste', 'größte', 'bekannt', 'berühmt', 'zentral',
      'beispiel', 'jedoch', 'deshalb', 'daher', 'also'
    ];
    
    const lowerSent = sent.toLowerCase();
    keywords.forEach(keyword => {
      if (lowerSent.includes(keyword)) score += 0.5;
    });
    
    // 4. Enthält Zahlen/Daten (oft wichtige Fakten)
    if (/\d+/.test(sent)) score += 1;
    
    // 5. Vermeide sehr kurze Sätze
    if (len < 20) score -= 2;
    
    return { text: sent, score, index };
  });
  
  // Sortiere nach Score und nimm die besten
  const topSentences = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, targetSentences);
  
  // Sortiere zurück in ursprüngliche Reihenfolge für Lesbarkeit
  const result = topSentences
    .sort((a, b) => a.index - b.index)
    .map(s => s.text)
    .join(" ");
  
  return result;
}

/* -------------------- SCHNELLE Übersetzung (LibreTranslate) -------------------- */
async function translateWithLibre(text, targetLang) {
  if (targetLang === "en" || !text) return text;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    
    // Kürze Text falls zu lang (LibreTranslate Limit)
    const textToTranslate = text.length > 4000 
      ? text.substring(0, 4000) + "..."
      : text;
    
    const response = await fetch("https://libretranslate.com/translate", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        q: textToTranslate,
        source: "en",
        target: targetLang,
        format: "text"
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`LibreTranslate error: ${response.status}`);
      return text; // Fallback: Original zurückgeben
    }
    
    const data = await response.json();
    return data.translatedText || text;
    
  } catch (error) {
    console.log("Translation error:", error.message);
    return text; // Fallback: Original zurückgeben
  }
}

/* -------------------- Fetch mit Timeout -------------------- */
async function fetchWithTimeout(url, options = {}, timeout = TIMEOUT) {
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

  console.log("🚀 === START (SCHNELL-VERSION) ===");
  const startTime = Date.now();

  try {
    // Request Body parsen
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    // Validierung
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL fehlt oder ist ungültig" });
    }

    if (!language || typeof language !== "string") {
      return res.status(400).json({ error: "Sprache fehlt oder ist ungültig" });
    }

    console.log(`📝 URL: ${url}`);
    console.log(`🌍 Zielsprache: ${language}`);

    // 1) Webseite laden (mit Timeout)
    let pageResponse;
    try {
      pageResponse = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, 5000); // 5 Sekunden für Page Load
    } catch (error) {
      console.error("❌ Fehler beim Laden:", error.message);
      return res.status(502).json({ 
        error: "Webseite konnte nicht geladen werden",
        details: error.message 
      });
    }

    if (!pageResponse.ok) {
      return res.status(400).json({ 
        error: `Webseite antwortet mit Status ${pageResponse.status}` 
      });
    }

    const html = await pageResponse.text();
    console.log(`✅ HTML geladen: ${html.length} Zeichen (${Date.now() - startTime}ms)`);

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

    // 3) Text bereinigen und kürzen
    let cleaned = cleanText(article.textContent);
    
    if (cleaned.length > MAX_TEXT_LENGTH) {
      console.log(`⚠️ Text zu lang, kürze auf ${MAX_TEXT_LENGTH}`);
      cleaned = cleaned.substring(0, MAX_TEXT_LENGTH);
    }

    console.log(`🧹 Text bereinigt: ${cleaned.length} Zeichen (${Date.now() - startTime}ms)`);

    // 4) SCHNELLE Extraktive Zusammenfassung (keine API!)
    const summary = extractiveSummary(cleaned, 15);
    
    if (!summary || summary.length < 50) {
      return res.status(500).json({ 
        error: "Zusammenfassung fehlgeschlagen (zu kurz)" 
      });
    }

    console.log(`✅ Zusammenfassung erstellt: ${summary.length} Zeichen (${Date.now() - startTime}ms)`);

    // 5) Übersetzen mit LibreTranslate
    let finalText = summary;
    if (language !== "en") {
      finalText = await translateWithLibre(summary, language);
      console.log(`✅ Übersetzung abgeschlossen: ${finalText.length} Zeichen (${Date.now() - startTime}ms)`);
    }

    // 6) Erfolgreiche Antwort
    const totalTime = Date.now() - startTime;
    console.log(`🎉 === ERFOLG in ${totalTime}ms ===`);

    return res.status(200).json({
      title: article.title || "Artikel",
      summary: finalText,
      language: language,
      originalLength: article.textContent.length,
      cleanedLength: cleaned.length,
      summaryLength: summary.length,
      translatedLength: finalText.length,
      processingTime: totalTime
    });

  } catch (error) {
    console.error("❌ Unerwarteter Fehler:", error);
    
    return res.status(500).json({ 
      error: "Ein interner Fehler ist aufgetreten",
      details: error.message 
    });
  }
}
