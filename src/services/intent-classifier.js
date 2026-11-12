require('../utils/config');
const { chatCompletion } = require('./model-client');

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
 * Rule-based classifier used as an instant fallback when LLM is unavailable.
 * Routes numerical/comparison questions to DIRECT_SQL and narrative/policy questions to AZURE_SEARCH.
 */
function classifyIntentByRules(question) {
    const q = (question || '').toLowerCase();

    // Check for policy, guideline, or handbook keywords (English & Arabic)
    const isQualitative = /(policy|policies|guideline|guidelines|procedure|procedures|handbook|overview|terms|eligibility|rules|regulation|regulations|instructions|process|overview|شروط|سياسة|سياسات|دليل|إجراءات)/i.test(q);

    // Check for period-over-period comparison keywords (English & Arabic)
    const isComparison = /(compare|comparison|versus|\bvs\b|difference|variance|growth|increase|decrease|change\s+between|مقارنة|قارن|الفرق|التباين|النمو|الزيادة|النقص)/i.test(q);

    // Check for financial & HR metric keywords (English & Arabic)
    const isFinancialMetric = !isQualitative && (
        /(revenue|salaries|salary|rent|profit|income|invoice|invoices|amount|count|balance|paid|unpaid|pending|ebitda|tax|taxes|turnover|cost|costs|fees|expense|expenses|cash\s*flow|total|approved|declined|إيرادات|ايرادات|مصروفات|مصاريف|الرواتب|أجور|اجور|الربح|الأرباح|ارباح|الدخل|المبيعات|عدد\s+الموظفين|الموظفين|الضريبة|التكلفة|تكلفة)/i.test(q)
    );

    // Extract dates or fiscal periods (e.g. October 2026, Q1, FY24, ٢٠٢٤)
    const periodMatches = question.match(/(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|q[1-4](?:\s+\d{4})?|fy\s*\d{2,4}|\d{4}|الربع\s+(?:الأول|الثاني|الثالث|الرابع)|٢٠\d{2})/gi) || [];

    if ((isFinancialMetric || isComparison) && !isQualitative) {
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
 * Classifies user intent using the active LLM (Azure or Groq).
 * Falls back to rule-based routing if the LLM is unreachable.
 */
async function classifyIntent(question, options = {}) {
    const jobId = typeof options === 'string' ? options : (options?.jobId || options?.correlationId || null);

    try {
        const response = await chatCompletion({
            messages: [
                { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
                { role: 'user', content: `Question: "${question}"` }
            ],
            temperature: 0.0,
            maxTokens: 300,
            responseFormat: { type: 'json_object' },
            timeoutMs: 10000, // Fast 10-second timeout for intent classification
            jobId
        });

        const rawContent = (response.text || '').trim();
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
                    reasoning: parsed.reasoning || `Classified by LLM (${response.provider})`,
                    provider: response.provider,
                    model: response.model,
                    usage: response.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
                };
            }
        }
    } catch (err) {
        console.warn(`[IntentClassifier]${jobId ? ` [Job: ${jobId}]` : ''} LLM intent classification failed, falling back to rule engine:`, err.message);
    }

    return classifyIntentByRules(question);
}

module.exports = {
    classifyIntent,
    classifyIntentByRules
};
