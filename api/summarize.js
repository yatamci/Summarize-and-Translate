import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// Timeout für fetch-Aufrufe
const fetchWithTimeout = (url, options = {}, timeout = 10000) => {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeout)
        )
    ]);
};

export default async function handler(req, res) {
    // CORS Headers für Browser
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        /* 1️⃣ Body sicher parsen */
        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (parseError) {
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        const { url, language } = body;

        if (!url || !language) {
            return res.status(400).json({ 
                error: 'Missing parameters',
                required: ['url', 'language']
            });
        }

        // URL validieren
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ error: 'Invalid URL protocol' });
            }
        } catch (urlError) {
            return res.status(400).json({ error: 'Invalid URL format' });
        }

        /* 2️⃣ Webseite laden mit Timeout und User-Agent */
        console.log(`Fetching: ${url}`);
        let html;
        try {
            const pageResponse = await fetchWithTimeout(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }, 15000);
            
            if (!pageResponse.ok) {
                return res.status(400).json({ 
                    error: `Failed to fetch URL: ${pageResponse.status} ${pageResponse.statusText}` 
                });
            }
            
            html = await pageResponse.text();
        } catch (fetchError) {
            console.error('Fetch error:', fetchError);
            return res.status(400).json({ 
                error: 'Could not fetch the article. The website might be blocking the request.',
                details: fetchError.message
            });
        }

        if (!html || html.length < 100) {
            return res.status(400).json({ error: 'Empty or too small HTML response' });
        }

        /* 3️⃣ Artikel extrahieren */
        let article;
        try {
            const dom = new JSDOM(html, { url });
            const reader = new Readability(dom.window.document);
            article = reader.parse();
        } catch (parseError) {
            console.error('Readability error:', parseError);
            return res.status(400).json({ 
                error: 'Could not parse article content',
                details: 'The website structure might not be compatible'
            });
        }

        if (!article || !article.textContent || article.textContent.trim().length < 50) {
            return res.status(400).json({ 
                error: 'No article content detected',
                suggestion: 'Try a different website or check if the URL points directly to an article'
            });
        }

        // Text auf vernünftige Länge kürzen
        const rawText = article.textContent.trim();
        const text = rawText.length > 5000 ? rawText.slice(0, 5000) + '...' : rawText;

        console.log(`Article length: ${text.length} chars`);

        /* 4️⃣ Zusammenfassung mit Hugging Face */
        let summary;
        try {
            console.log('Calling Hugging Face API...');
            
            // OPTION 1: Direkter Hugging Face Inference API Call (empfohlen)
            const hfResponse = await fetchWithTimeout(
                `https://api-inference.huggingface.co/models/facebook/bart-large-cnn`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${process.env.HF_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        inputs: text,
                        parameters: {
                            max_length: 200,
                            min_length: 50,
                            do_sample: false
                        }
                    })
                },
                30000
            );

            if (!hfResponse.ok) {
                const errorText = await hfResponse.text();
                console.error('HF API error:', hfResponse.status, errorText);
                
                // Fallback: Einfache Textverkürzung
                summary = text.split('.').slice(0, 3).join('.') + '...';
                console.log('Using fallback summary');
            } else {
                const hfData = await hfResponse.json();
                
                if (hfData.error) {
                    throw new Error(hfData.error);
                }
                
                if (Array.isArray(hfData) && hfData[0]?.summary_text) {
                    summary = hfData[0].summary_text;
                } else if (hfData.summary_text) {
                    summary = hfData.summary_text;
                } else if (hfData[0]?.generated_text) {
                    summary = hfData[0].generated_text;
                } else {
                    throw new Error('Unexpected response format from Hugging Face');
                }
            }
        } catch (hfError) {
            console.error('Summarization error:', hfError);
            // Fallback: Ersten Absatz nehmen
            const sentences = text.split(/[.!?]+/);
            summary = sentences.slice(0, 3).join('. ') + '.';
        }

        /* 5️⃣ Übersetzung mit Fallback-Optionen */
        let translatedText;
        
        // OPTION A: LibreTranslate (Primär)
        try {
            console.log('Trying LibreTranslate...');
            const translateResponse = await fetchWithTimeout(
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
                        format: "text",
                        api_key: "" // Leer lassen für öffentlichen Server
                    })
                },
                15000
            );

            if (translateResponse.ok) {
                const translateData = await translateResponse.json();
                if (translateData.translatedText) {
                    translatedText = translateData.translatedText;
                    console.log('Translation successful via LibreTranslate');
                }
            }
        } catch (ltError) {
            console.log('LibreTranslate failed, trying fallback...');
        }

        // OPTION B: MyMemory Translator Fallback
        if (!translatedText) {
            try {
                console.log('Trying MyMemory Translator...');
                const mmResponse = await fetchWithTimeout(
                    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(summary)}&langpair=en|${language}`,
                    {},
                    15000
                );
                
                if (mmResponse.ok) {
                    const mmData = await mmResponse.json();
                    if (mmData.responseData && mmData.responseData.translatedText) {
                        translatedText = mmData.responseData.translatedText;
                        console.log('Translation successful via MyMemory');
                    }
                }
            } catch (mmError) {
                console.log('MyMemory fallback also failed');
            }
        }

        // OPTION C: Falls alles fehlschlägt, original Summary zurückgeben
        if (!translatedText) {
            translatedText = summary;
            console.log('Using original summary as fallback');
        }

        /* ✅ Erfolg */
        console.log('Successfully processed article');
        res.status(200).json({
            success: true,
            title: article.title || 'Untitled',
            summary: translatedText,
            originalSummary: summary,
            language: language,
            url: url
        });

    } catch (error) {
        console.error("❌ Unhandled API ERROR:", error);
        res.status(500).json({
            error: "Internal server error",
            details: process.env.NODE_ENV === 'development' ? error.message : undefined,
            suggestion: "Please try again with a different URL or contact support"
        });
    }
}
