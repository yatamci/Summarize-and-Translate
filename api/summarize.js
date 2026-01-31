// api/summarize.js - MIT DEBUGGING FÜR ÜBERSETZUNG
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const TIMEOUT = 8000;
const MAX_TEXT_LENGTH = 100000;

// Language Code Mapping für LibreTranslate
const LANG_MAP = {
  de: "de",
  en: "en",
  es: "es",
  fr: "fr",
  it: "it",
  nl: "nl",
  da: "da", // Dänisch
  no: "no", // Norwegisch  
  sv: "sv", // Schwedisch
  fi: "fi", // Finnisch
  pl: "pl",
  cs: "cs",
  ru: "ru"
};

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\[\s*\d+(?:[,\s\-–—]*\d+)*\s*\]/g, "")
    .replace(/\[\s*[a-zA-Z]+\s*\]/g, "")
    .replace(/\[\s*cite[^\]]*\]/gi, "")
    .replace(/\(siehe[^)]*\)/gi, "")
    .replace(/\(vgl\.[^)]*\)/gi, "")
    .replace(/\[Bearbeiten[^\]]*\]/gi, "")
    .replace(/\[edit\]/gi, "")
    .replace(/\^/g, "")
    .replace(/Main article:\s*[^\n]*/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function extractiveSummary(text, targetSentences = 15) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  
  if (sentences.length === 0) return text.substring(0, 500);
  if (sentences.length <= targetSentences) return sentences.join(" ");
  
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    const sent = sentence.trim();
    const len = sent.length;
    
    if (index < 3) score += 5;
    else if (index < 10) score += 3;
    else if (index < 20) score += 1;
    
    if (len > 40 && len < 200) score += 3;
    else if (len > 20 && len < 300) score += 1;
    
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
    
    if (/\d+/.test(sent)) score += 1;
    if (len < 20) score -= 2;
    
    return { text: sent, score, index };
  });
  
  const topSentences = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, targetSentences);
  
  const result = topSentences
    .sort((a, b) => a.index - b.index)
    .map(s => s.text)
    .join(" ");
  
  return result;
}

async function translateWithLibre(text, targetLang) {
  if (targetLang === "en" || !text) return text;
  
  // Mappe Sprach-Code
  const libreCode = LANG_MAP[targetLang];
  if (!libreCode) {
    console.log(`⚠️ Sprache ${targetLang} nicht unterstützt, gebe Original zurück`);
    return text;
  }
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    
    const textToTranslate = text.length > 3500 
      ? text.substring(0, 3500) + "..."
      : text;
    
    console.log(`🌍 Übersetze ${textToTranslate.length} Zeichen von EN → ${libreCode}`);
    
    const response = await fetch("https://libretranslate.com/translate", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        q: textToTranslate,
        source: "en",
        target: libreCode,
        format: "text"
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.log(`❌ LibreTranslate Fehler ${response.status}: ${errorText}`);
      return text;
    }
    
    const data = await response.json();
    
    if (!data.translatedText) {
      console.log("❌ Keine translatedText im Response");
      return text;
    }
    
    console.log(`✅ Übersetzung erfolgreich: ${data.translatedText.length} Zeichen`);
    return data.translatedText;
    
  } catch (error) {
    console.log(`❌ Übersetzungs-Exception: ${error.message}`);
    return text;
  }
}

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Nur POST" });

  console.log("🚀 === START ===");
  const startTime = Date.now();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { url, language } = body || {};

    if (!url) return res.status(400).json({ error: "URL fehlt" });
    if (!language) return res.status(400).json({ error: "Sprache fehlt" });

    console.log(`📝 URL: ${url}`);
    console.log(`🌍 Zielsprache: ${language}`);

    let pageResponse;
    try {
      pageResponse = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html"
        }
      }, 5000);
    } catch (error) {
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
    console.log(`✅ HTML: ${html.length} Zeichen (${Date.now() - startTime}ms)`);

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(400).json({ error: "Kein Artikel gefunden" });
    }

    console.log(`📄 "${article.title}" (${article.textContent.length} Zeichen)`);

    let cleaned = cleanText(article.textContent);
    if (cleaned.length > MAX_TEXT_LENGTH) {
      cleaned = cleaned.substring(0, MAX_TEXT_LENGTH);
    }

    console.log(`🧹 Bereinigt: ${cleaned.length} Zeichen (${Date.now() - startTime}ms)`);

    const summary = extractiveSummary(cleaned, 15);
    
    if (!summary || summary.length < 50) {
      return res.status(500).json({ error: "Zusammenfassung zu kurz" });
    }

    console.log(`✅ Zusammenfassung: ${summary.length} Zeichen (${Date.now() - startTime}ms)`);

    let finalText = summary;
    if (language !== "en") {
      console.log(`🔄 Starte Übersetzung nach ${language}...`);
      finalText = await translateWithLibre(summary, language);
      console.log(`✅ Übersetzung fertig: ${finalText.length} Zeichen (${Date.now() - startTime}ms)`);
    }

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
    console.error("❌ Fehler:", error);
    return res.status(500).json({ 
      error: "Interner Fehler",
      details: error.message 
    });
  }
}
