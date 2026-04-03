const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
                    console.log('Claude response type:', parsed.type, '| stop_reason:', parsed.stop_reason);
                    if (parsed.error) console.error('Claude API error:', JSON.stringify(parsed.error));
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Claude parse error: ' + data.substring(0, 300)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function extractText(content) {
    if (!Array.isArray(content)) {
        console.error('extractText: content is not an array:', typeof content, content);
        return '';
    }
    const texts = [];
    for (const block of content) {
        if (block.type === 'text' && block.text) {
            texts.push(block.text);
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
            for (const inner of block.content) {
                if (inner.type === 'text' && inner.text) texts.push(inner.text);
            }
        }
    }
    const result = texts.join('');
    if (!result) console.warn('extractText: no text found in content blocks:', JSON.stringify(content).substring(0, 300));
    return result;
}

app.post('/api/init', async (req, res) => {
    const { name, enquiry } = req.body;
    if (!name || !enquiry) return res.status(400).json({ error: 'Name and enquiry required' });
    console.log(`Init call: ${name} — "${enquiry}"`);

    try {
        const searchRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 3000,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            system: `You are a research assistant for a car dealership. 
Search gravelwood.co.uk and find the specific vehicle a customer is enquiring about.
Extract ALL available details: full name, year, price, mileage, colour, engine, BHP, transmission, 0-62, MPG, features, extras with prices, stock ref, URL.
Return a detailed plain-text summary of everything you find.
If the enquiry is vague, find the closest match on the site.
If no match found, summarise what is available on gravelwood.co.uk.`,
            messages: [{
                role: 'user',
                content: `Customer enquiry: "${enquiry}"\n\nSearch gravelwood.co.uk for this vehicle and return a comprehensive summary of all its details.`
            }]
        });

        const carContext = extractText(searchRes.content);
        console.log('Car context length:', carContext.length);

        const nameRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 30,
            system: 'Return ONLY the year, make and model of the car. E.g. "2024 Land Rover Range Rover". No other text.',
            messages: [{ role: 'user', content: carContext || 'Unknown vehicle' }]
        });
        const carName = extractText(nameRes.content).trim();
        console.log('Car name:', carName);

        const greetRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 200,
            system: buildSystemPrompt(carContext),
            messages: [{
                role: 'user',
                content: `Generate a warm, professional opening greeting for a call with ${name}. Their enquiry was: "${enquiry}". Keep it to 2-3 sentences. Acknowledge the specific car and invite questions.`
            }]
        });

        const openingMessage = extractText(greetRes.content);
        console.log('Opening message length:', openingMessage.length);

        res.json({ carContext, carName, openingMessage });

    } catch (err) {
        console.error('Init error:', err.message);
        res.status(500).json({ error: 'Failed to initialise call: ' + err.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { messages, carContext, customerName } = req.body;
    if (!messages || !carContext) return res.status(400).json({ error: 'Missing required fields' });

    try {
        const chatRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 400,
            system: buildSystemPrompt(carContext, customerName),
            messages
        });

        const reply = extractText(chatRes.content);
        console.log('Chat reply length:', reply.length);

        const flagged = /don't have that detail|make a note|follow.?up|not sure about that|sales team will|contact.*team/i.test(reply);

        res.json({ reply, flagged });

    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: 'Failed to get response' });
    }
});

app.post('/api/summary', async (req, res) => {
    const { transcript, customerName, enquiry, flaggedQuestions, carName } = req.body;

    try {
        const sumRes = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 700,
            system: 'You write concise, professional post-call lead summaries for a prestige car dealership sales team. Be direct and actionable.',
            messages: [{
                role: 'user',
                content: `Write a sales team summary for this AI agent call:

Customer: ${customerName}
Vehicle enquired about: ${carName || 'Unknown'}
Original enquiry: "${enquiry}"
Questions the agent could not fully answer: ${flaggedQuestions.length > 0 ? flaggedQuestions.join('; ') : 'None'}

Call transcript:
${transcript}

Structure your summary as:
LEAD TEMPERATURE: [Hot / Warm / Cold] — one sentence reason
KEY INTERESTS: bullet points
CONCERNS / OBJECTIONS: bullet points (or "None raised")
QUESTIONS NEEDING FOLLOW-UP: bullet points (or "None")
RECOMMENDED NEXT ACTION: one clear sentence`
            }]
        });

        res.json({ summary: extractText(sumRes.content) });

    } catch (err) {
        console.error('Summary error:', err.message);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

function buildSystemPrompt(carContext, customerName) {
    return `You are a professional AI sales agent for Gravelwood Car Sales — a prestige used car dealership near Brands Hatch in Kent, UK.

DEALERSHIP:
- Address: Unit 4a, West Yoke Farm, Michaels Lane, Sevenoaks, Kent, TN15 7EP
- Phone: 01474 874 873
- Hours: By appointment only, Monday to Saturday
- Nationwide delivery available
- Cars can be reserved for £500

VEHICLE YOU ARE BRIEFED ON:
${carContext}

YOUR RULES:
1. Be warm, knowledgeable, and professional — like a senior prestige car consultant
2. Use ONLY the vehicle details above — never invent or guess specifications, prices or features
3. Finance questions: give rough indicative monthly figures only, always recommend a formal quote from the sales team
4. Unknown details: say "That's a great question — I don't have that detail to hand right now, but I'll make sure our sales team follows up with you on that"
5. This is a voice call — keep responses to 2-4 sentences. Be concise.
6. If the customer shows interest, offer to arrange a viewing or test drive at the dealership
7. Other cars: say you only have full details on this specific vehicle but the team can help with anything else in stock
8. Never fabricate information — trust is everything in prestige car sales`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✓ Gravelwood AI Agent running on port ${PORT}`);
    if (!ANTHROPIC_API_KEY) console.warn('⚠ WARNING: ANTHROPIC_API_KEY is not set');
});
