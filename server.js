const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Fetch a webpage ──────────────────────────────────────────────────────────

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Gravelwood-Agent/1.0)' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// Strip HTML tags and collapse whitespace to get clean text
function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 8000); // Keep it lean
}

// ─── Claude API Helper ────────────────────────────────────────────────────────

function callClaude(payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        console.error('Claude API error:', parsed.error.type, parsed.error.message);
                        reject(new Error(parsed.error.message));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error('Parse error: ' + data.substring(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function extractText(content) {
    if (!Array.isArray(content)) return '';
    return content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/init
app.post('/api/init', async (req, res) => {
    const { name, enquiry } = req.body;
    if (!name || !enquiry) return res.status(400).json({ error: 'Name and enquiry required' });
    console.log(`Init: ${name} — "${enquiry}"`);

    try {
        // Step 1: Fetch Gravelwood stock page directly — no web search tool
        let pageText = '';
        try {
            const html = await fetchPage('https://www.gravelwood.co.uk/used-cars-for-sale/');
            pageText = stripHtml(html);
            console.log('Page fetched, length:', pageText.length);
        } catch (e) {
            console.error('Page fetch failed:', e.message);
            pageText = 'Could not fetch live inventory. Use general knowledge about Gravelwood Car Sales.';
        }

        // Step 2: Ask Claude to find the matching car from the page text
        const findRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: 'You are a car dealership assistant. Extract details about a specific car from webpage text. Return a concise plain-text summary of the matching car including: name, price, mileage, colour, engine, key features. If you cannot find a match, say what cars are available.',
            messages: [{
                role: 'user',
                content: `Customer is asking about: "${enquiry}"\n\nWebpage text:\n${pageText}\n\nFind the matching car and summarise its details.`
            }]
        });

        const carContext = extractText(findRes.content);
        console.log('Car context:', carContext.substring(0, 100));

        // Step 3: Generate opening greeting
        const greetRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 150,
            system: buildSystemPrompt(carContext),
            messages: [{
                role: 'user',
                content: `Say hello to ${name} and acknowledge their interest in: "${enquiry}". 2 sentences max.`
            }]
        });

        const openingMessage = extractText(greetRes.content);
        console.log('Opening:', openingMessage.substring(0, 80));

        res.json({ carContext, carName: enquiry, openingMessage });

    } catch (err) {
        console.error('Init error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// POST /api/chat
app.post('/api/chat', async (req, res) => {
    const { messages, carContext, customerName } = req.body;
    if (!messages || !carContext) return res.status(400).json({ error: 'Missing fields' });

    try {
        const chatRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 300,
            system: buildSystemPrompt(carContext, customerName),
            messages
        });

        const reply = extractText(chatRes.content);
        console.log('Reply:', reply.substring(0, 80));

        const flagged = /don't have that detail|make a note|follow.?up|sales team/i.test(reply);
        res.json({ reply, flagged });

    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// POST /api/summary
app.post('/api/summary', async (req, res) => {
    const { transcript, customerName, enquiry, flaggedQuestions, carName } = req.body;

    try {
        const sumRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: 'Write concise post-call lead summaries for a car dealership sales team.',
            messages: [{
                role: 'user',
                content: `Customer: ${customerName}\nCar: ${carName}\nEnquiry: "${enquiry}"\nUnanswered questions: ${flaggedQuestions.join('; ') || 'None'}\n\nTranscript:\n${transcript}\n\nSummarise: lead temperature (Hot/Warm/Cold), key interests, next action.`
            }]
        });

        res.json({ summary: extractText(sumRes.content) });

    } catch (err) {
        console.error('Summary error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(carContext, customerName) {
    return `You are a professional AI sales agent for Gravelwood Car Sales — a prestige used car dealer near Brands Hatch in Kent, UK. Phone: 01474 874 873. By appointment only.

VEHICLE DETAILS:
${carContext}

RULES:
- Be warm and professional — like a senior prestige car consultant
- Only use the vehicle details above — never invent specs or prices
- Keep responses to 2-3 sentences — this is a voice call
- If you don't know something say: "I'll make sure the sales team follows up on that"
- If customer is interested, offer to arrange a viewing or test drive`;
}


// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✓ Gravelwood AI Agent running on port ${PORT}`);
    if (!ANTHROPIC_API_KEY) console.warn('⚠ ANTHROPIC_API_KEY not set');
});
