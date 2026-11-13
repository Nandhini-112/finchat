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
  "metrics": ["exact metric names detected in the question, e.g. net profit, gross profit, revenue, operating expenses"],
  "periods": ["list_of_periods_or_dates"],
  "entities": ["list of company/entity/organization names explicitly mentioned in the question, e.g. Contoso Retail, Contoso Properties LLC. Empty array if none mentioned."],
  "isComparison": true | false,
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation"
}`;

// Ordered from most-specific to least-specific so longer phrases match first
const KNOWN_METRIC_PATTERNS = [
    'net profit for the period',
    'net profit',
    'gross profit',
    'operating profit',
    'profit before tax',
    'profit after tax',
    'total revenue',
    'operating revenue',
    'other income',
    'operating expenses',
    'total expenses',
    'general and administrative',
    'selling expenses',
    'finance costs',
    'finance income',
    'depreciation and amortization',
    'depreciation',
    'amortization',
    'ebitda',
    'ebit',
    'operating income',
    'net income',
    'income tax',
    'tax expense',
    'revenue',
    'sales',
    'turnover',
    'expenses',
    'expense',
    'cost of goods sold',
    'cost of sales',
    'costs',
    'cost',
    'salaries',
    'salary',
    'payroll',
    'wages',
    'compensation',
    'headcount',
    'employee count',
    'employees',
    'attrition',
    'cash and bank',
    'bank balance',
    'cash balance',
    'cash flow',
    'cash',
    'accounts receivable',
    'receivables',
    'accounts payable',
    'payables',
    'inventory',
    'total assets',
    'total liabilities',
    'total equity',
    'assets',
    'liabilities',
    'equity',
    'profit',
    'income',
    'tax',
    'taxes',
    'rent',
    'office rent',
    'invoices',
    'invoice'
];

/**
 * Extract metric names from a question using an ordered regex list.
 * Returns an array of distinct matched metric strings (longest match wins).
 */
function extractMetricsFromQuestion(question) {
    const q = (question || '').toLowerCase();
    const matched = new Set();

    // Try each pattern in order (most-specific first)
    for (const pattern of KNOWN_METRIC_PATTERNS) {
        // Use word-boundary-like check: pattern preceded/followed by non-word chars
        const regex = new RegExp(`(?<![a-z])${pattern.replace(/\s+/g, '\\s+')}(?![a-z])`, 'i');
        if (regex.test(q)) {
            // Only add if no already-matched pattern already contains this one
            const dominated = [...matched].some(m => m.includes(pattern) || pattern.includes(m) && m.length > pattern.length);
            if (!dominated) {
                matched.add(pattern);
            }
        }
    }

    return [...matched];
}

/**
 * Extract entity names from a question using regex heuristics.
 * Looks for "Contoso *", "Acme *", or any capitalized multi-word proper noun phrases.
 * This is used as a fallback / supplement when the LLM doesn't return entities.
 */
function extractEntitiesFromQuestion(question) {
    const entities = new Set();

    // Match well-known Contoso-style brand names (Contoso + optional word + optional LLC/Ltd/Inc/Corp)
    const contosoPattern = /Contoso\s+\w+(?:\s+(?:LLC|Ltd|Inc|Corp|Group|Holdings|Retail|Properties|Logistics|Finance|Services|Solutions))?/gi;
    const contosoMatches = question.match(contosoPattern) || [];
    contosoMatches.forEach(m => entities.add(m.trim()));

    // Match generic "Company Name LLC / Ltd / Inc / Corp / Holdings / Group" patterns
    const corpPattern = /\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s+(?:LLC|Ltd|Inc|Corp|Holdings|Group|Properties|Retail|Logistics)\b/g;
    const corpMatches = question.match(corpPattern) || [];
    corpMatches.forEach(m => entities.add(m.trim()));

    return [...entities];
}

/**
 * Fast regex-based fallback if LLM classification fails or is unavailable.
 */
function classifyIntentByRules(question) {
    const q = (question || '').toLowerCase();

    // Check for comparison keywords (English & Arabic)
    const isComparison = /(compare|comparison|versus|\bvs\b|difference|variance|growth|increase|decrease|change\s+between|مقارنة|قارن|الفرق|التباين|النمو|الزيادة|النقص)/i.test(q);

    // Check for financial & HR metric keywords (English & Arabic)
    const isFinancialMetric = /(revenue|expense|salaries|salary|rent|profit|income|invoice|invoices|amount|count|balance|paid|unpaid|pending|ebitda|tax|taxes|turnover|cost|costs|fees|cash\s*flow|total|approved|declined|إيرادات|ايرادات|مصروفات|مصاريف|الرواتب|أجور|اجور|الربح|الأرباح|ارباح|الدخل|المبيعات|عدد\s+الموظفين|الموظفين|الضريبة|التكلفة|تكلفة)/i.test(q);

    // Extract potential period or date mentions (English & Arabic e.g. October 2026, Q1, الربع الثالث, ٢٠٢٤)
    const periodMatches = question.match(/(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|q[1-4](?:\s+\d{4})?|fy\s*\d{2,4}|\d{4}|الربع\s+(?:الأول|الثاني|الثالث|الرابع)|٢٠\d{2})/gi) || [];

    const entities = extractEntitiesFromQuestion(question);

    // Extract metrics from query text
    const metrics = extractMetricsFromQuestion(question);

    if (isFinancialMetric || isComparison) {
        return {
            route: 'DIRECT_SQL',
            intentType: isComparison ? 'PERIOD_COMPARISON' : 'SINGLE_PERIOD_FACT',
            metrics,
            periods: periodMatches.map(p => p.trim()),
            entities,
            isComparison,
            confidence: 0.85,
            reasoning: 'Rule-based match on financial metric / comparison keywords'
        };
    }

    return {
        route: 'AZURE_SEARCH',
        intentType: 'GENERAL_SEARCH',
        metrics,
        periods: periodMatches.map(p => p.trim()),
        entities,
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
                // Merge LLM entities with regex-extracted entities for reliability
                const llmEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
                const regexEntities = extractEntitiesFromQuestion(question);
                const mergedEntities = [...new Set([...llmEntities, ...regexEntities])];

                // Merge LLM metrics with regex-extracted metrics for reliability
                const llmMetrics = Array.isArray(parsed.metrics) ? parsed.metrics.map(m => m.toLowerCase().trim()) : [];
                const regexMetrics = extractMetricsFromQuestion(question);
                const mergedMetrics = [...new Set([...llmMetrics, ...regexMetrics])];

                return {
                    route: parsed.route,
                    intentType: parsed.intentType || (parsed.isComparison ? 'PERIOD_COMPARISON' : 'SINGLE_PERIOD_FACT'),
                    metrics: mergedMetrics,
                    periods: Array.isArray(parsed.periods) ? parsed.periods : [],
                    entities: mergedEntities,
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
    classifyIntentByRules,
    extractEntitiesFromQuestion,
    extractMetricsFromQuestion,
    KNOWN_METRIC_PATTERNS
};
