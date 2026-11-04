require('../utils/config');
const OpenAI = require('openai').default;

let llmClient = null;

function getLLMClient() {
    if (!llmClient) {
        const apiKey = process.env.GROQ_API_KEY || process.env.AZURE_OPENAI_API_KEY;
        const baseURL = process.env.GROQ_BASE_URL || (process.env.AZURE_OPENAI_ENDPOINT ? `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/v1` : undefined);

        if (!apiKey) {
            return null;
        }

        llmClient = new OpenAI({
            apiKey,
            baseURL,
            maxRetries: 2,
            timeout: 10000 // Fast 10-second timeout for intent classification
        });
    }
    return llmClient;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a financial query intent classifier and router for Finora AI.
Analyze the user's financial question and classify it into one of two routing paths:

1. DIRECT_SQL:
   - For exact numerical financial metrics, amounts, counts, or balances (e.g., Revenue, Expenses, Salaries, Office Rent, Net Profit, Invoices, Paid/Unpaid/Pending transactions, Cash Flow).
   - For single-period fact retrieval (e.g., "What was the revenue in October 2026?").
   - For comparisons between dates or periods (e.g., "Compare October vs November revenue", "What is the difference between Q1 and Q2 expenses?").

2. AZURE_SEARCH:
   - For qualitative, narrative, or policy inquiries (e.g., HR policies, management notes, company overview, audit observations, procedures, general descriptions, summary explanations).

You must respond ONLY with a raw JSON object (no markdown, no backticks, no preamble) adhering to this schema:
{
  "route": "DIRECT_SQL" | "AZURE_SEARCH",
  "intentType": "SINGLE_PERIOD_FACT" | "PERIOD_COMPARISON" | "GENERAL_SEARCH",
  "metrics": ["list", "of", "metrics"],
  "periods": ["list", "of", "periods_or_dates"],
  "isComparison": true | false,
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation"
}`;

/**
 * Fast regex-based fallback if LLM classification fails or is unavailable.
 */
function classifyIntentByRules(question) {
    const q = (question || '').toLowerCase();

    // Check for comparison keywords
    const isComparison = /(compare|comparison|versus|\bvs\b|difference|variance|growth|increase|decrease|change\s+between)/i.test(q);

    // Check for financial metric keywords
    const isFinancialMetric = /(revenue|expense|salaries|salary|rent|profit|income|invoice|invoices|amount|count|balance|paid|unpaid|pending|ebitda|tax|taxes|turnover|cost|costs|fees|cash\s*flow|total|approved|declined)/i.test(q);

    // Extract potential period or date mentions (e.g. October 2026, Q1, FY24)
    const periodMatches = question.match(/(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|q[1-4](?:\s+\d{4})?|fy\s*\d{2,4}|\d{4})/gi) || [];

    if (isFinancialMetric || isComparison) {
        return {
            route: 'DIRECT_SQL',
            intentType: isComparison ? 'PERIOD_COMPARISON' : 'SINGLE_PERIOD_FACT',
            metrics: [],
            periods: periodMatches.map(p => p.trim()),
            isComparison,
            confidence: 0.85,
            reasoning: 'Rule-based match on financial metric / comparison keywords'
        };
    }

    return {
        route: 'AZURE_SEARCH',
        intentType: 'GENERAL_SEARCH',
        metrics: [],
        periods: periodMatches.map(p => p.trim()),
        isComparison: false,
        confidence: 0.80,
        reasoning: 'Rule-based fallback to semantic search'
    };
}

/**
 * Classify user intent using LLM with deterministic rule fallback.
 */
async function classifyIntent(question) {
    const client = getLLMClient();
    const model = process.env.GROQ_MODEL || process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || (process.env.GROQ_API_KEY ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini');

    if (!client) {
        return classifyIntentByRules(question);
    }

    try {
        const response = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
                { role: 'user', content: `Question: "${question}"` }
            ],
            temperature: 0.0,
            max_tokens: 300,
            response_format: { type: 'json_object' }
        });

        const rawContent = response.choices?.[0]?.message?.content?.trim();
        if (rawContent) {
            const parsed = JSON.parse(rawContent);
            if (parsed.route && (parsed.route === 'DIRECT_SQL' || parsed.route === 'AZURE_SEARCH')) {
                return {
                    route: parsed.route,
                    intentType: parsed.intentType || (parsed.isComparison ? 'PERIOD_COMPARISON' : 'SINGLE_PERIOD_FACT'),
                    metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
                    periods: Array.isArray(parsed.periods) ? parsed.periods : [],
                    isComparison: Boolean(parsed.isComparison),
                    confidence: Number(parsed.confidence) || 0.95,
                    reasoning: parsed.reasoning || 'Classified by LLM'
                };
            }
        }
    } catch (err) {
        console.warn('[IntentClassifier] LLM intent classification failed, falling back to rule engine:', err.message);
    }

    return classifyIntentByRules(question);
}

module.exports = {
    classifyIntent,
    classifyIntentByRules
};
