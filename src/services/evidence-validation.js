/**
 * Filter a fact set to those relevant to the given question and optional intent.
 *
 * Priority order:
 *  1. If intent.entities is populated, pre-filter facts to only those whose
 *     Entity column or SourceFileName matches one of the extracted entities.
 *     Uses distinctive entity tokens (e.g. "properties" vs "retail" vs "logistics")
 *     and ignores generic brand stop words (e.g. "contoso", "company", "llc").
 *  2. If intent.periods is populated, further restrict to matching PeriodLabel.
 *  3. Apply metric-based matching: if specific metrics are mentioned in the query
 *     or intent, prioritize facts matching those metrics.
 *  4. Apply keyword-based heuristics (transaction IDs, status words, etc.)
 *     on the entity/period-filtered set.
 *  5. If the user asked for specific financial metrics and NO matching facts exist,
 *     return [] so the system can fall through to Azure AI Search chunks instead
 *     of passing unrelated facts (e.g. Cash/Inventory for a Net Profit question).
 *
 * @param {string} question  - Raw user question
 * @param {Array}  facts     - Array of fact objects from dbo.FinancialFacts
 * @param {Object} [intent]  - Optional intent object with .entities, .periods, .metrics
 * @returns {Array} Filtered & deduplicated facts
 */
const BRAND_STOP_WORDS = new Set([
    'contoso', 'corporation', 'corporate', 'company', 'limited', 'holdings',
    'group', 'services', 'solutions', 'technologies', 'llc', 'ltd', 'inc', 'corp'
]);

function findRelevantStructuredFacts(question, facts = [], intent = null) {
    if (!facts || facts.length === 0) return [];

    const q = (question || '').toLowerCase();

    const getEntity = f => (f.Entity || f.entity || '');
    const getMetric = f => (f.Metric || f.metric || '');
    const getFileName = f => (f.SourceFileName || f.sourceFileName || '');
    const getPeriod = f => (f.PeriodLabel || f.periodLabel || '');

    // -----------------------------------------------------------------------
    // PHASE 1: Entity-scoped pre-filter
    // -----------------------------------------------------------------------
    let scopedFacts = facts;

    const intentEntities = (intent && Array.isArray(intent.entities) && intent.entities.length > 0)
        ? intent.entities
        : [];

    if (intentEntities.length > 0) {
        const entityFiltered = facts.filter(f => {
            const entityVal = getEntity(f).toLowerCase();
            const fileNameVal = getFileName(f).toLowerCase();

            return intentEntities.some(e => {
                const eL = e.toLowerCase();
                // 1. Exact substring match in Entity field
                if (entityVal.includes(eL)) return true;

                // 2. Extract distinctive words (e.g. "properties" from "Contoso Properties LLC")
                const eWords = eL.split(/\s+/).filter(w => w.length > 2 && !BRAND_STOP_WORDS.has(w));

                if (eWords.length > 0) {
                    // All distinctive words must be in the entity or the filename
                    const matchesEntity = eWords.every(w => entityVal.includes(w));
                    const matchesFile = eWords.every(w => fileNameVal.includes(w));
                    if (matchesEntity || matchesFile) return true;
                } else {
                    // Fallback to exact match if no distinctive words exist
                    if (fileNameVal.includes(eL)) return true;
                }

                return false;
            });
        });

        if (entityFiltered.length > 0) {
            scopedFacts = entityFiltered;
        } else {
            // Target entity not found in SQL facts at all → return empty so
            // chat.js falls back to Azure AI Search semantic chunks.
            return [];
        }
    }

    // -----------------------------------------------------------------------
    // PHASE 2: Period-scoped filter (applied on top of entity scope)
    // -----------------------------------------------------------------------
    const intentPeriods = (intent && Array.isArray(intent.periods) && intent.periods.length > 0)
        ? intent.periods
        : [];

    let periodScopedFacts = scopedFacts;

    if (intentPeriods.length > 0) {
        const periodFiltered = scopedFacts.filter(f => {
            const periodVal = getPeriod(f).toLowerCase();
            if (!periodVal || periodVal === 'not specified') return true;
            return intentPeriods.some(p => periodVal.includes(p.toLowerCase()) || p.toLowerCase().includes(periodVal));
        });

        if (periodFiltered.length > 0) {
            periodScopedFacts = periodFiltered;
        }
    }

    // -----------------------------------------------------------------------
    // PHASE 3: Metric-specific matching
    // -----------------------------------------------------------------------
    const knownMetricTerms = [
        'net profit for the period', 'net profit', 'gross profit', 'operating profit', 'profit before tax',
        'total revenue', 'revenue', 'sales', 'turnover',
        'operating expenses', 'expenses', 'expense', 'cost of sales', 'cost', 'costs',
        'ebitda', 'ebit', 'operating income', 'net income',
        'salaries', 'salary', 'payroll', 'wages', 'compensation',
        'headcount', 'employee count', 'employees', 'attrition',
        'cash and bank', 'bank balance', 'cash balance', 'cash flow', 'cash',
        'accounts receivable', 'receivable', 'receivables',
        'accounts payable', 'payable', 'payables',
        'inventory', 'assets', 'total assets', 'liabilities', 'equity',
        'tax', 'taxes'
    ];

    let requestedMetrics = [];
    if (intent && Array.isArray(intent.metrics) && intent.metrics.length > 0) {
        requestedMetrics = intent.metrics.map(m => (m || '').toLowerCase().trim()).filter(Boolean);
    } else {
        // Fallback: extract specific metrics from question, preferring longer/more specific phrases first
        const matched = [];
        for (const term of knownMetricTerms) {
            if (q.includes(term)) {
                const isSubsumed = matched.some(m => m.includes(term) && m !== term);
                if (!isSubsumed) {
                    matched.push(term);
                }
            }
        }
        requestedMetrics = matched.filter(t => !matched.some(longer => longer.includes(t) && longer !== t));
    }

    let metricMatchedFacts = [];
    if (requestedMetrics.length > 0) {
        metricMatchedFacts = periodScopedFacts.filter(f => {
            const metricVal = getMetric(f).toLowerCase().trim();
            return requestedMetrics.some(rm => {
                if (metricVal === rm) return true;
                if (metricVal.startsWith(rm + ' ') || metricVal.endsWith(' ' + rm)) return true;
                if (rm.startsWith(metricVal + ' ') || rm.endsWith(' ' + metricVal)) return true;
                // Specific canonical synonyms
                if ((rm === 'net profit' || rm === 'net income') && (metricVal.includes('net profit') || metricVal.includes('net income'))) return true;
                if ((rm === 'gross profit' || rm === 'gross margin') && (metricVal.includes('gross profit') || metricVal.includes('gross margin'))) return true;
                if ((rm === 'operating profit' || rm === 'operating income') && (metricVal.includes('operating profit') || metricVal.includes('operating income'))) return true;
                if ((rm === 'total revenue' || rm === 'revenue' || rm === 'sales') && (metricVal.includes('revenue') || metricVal.includes('sales') || metricVal.includes('turnover'))) return true;
                return false;
            });
        });
    }

    // If specific metrics were requested and matching facts were found, return those!
    if (metricMatchedFacts.length > 0) {
        return deduplicateFacts(metricMatchedFacts);
    }

    // If the user explicitly asked for a specific financial metric (e.g. "net profit" or "revenue")
    // but SQL has ZERO facts matching that metric, do NOT return unrelated balance sheet facts!
    // Returning [] allows chat.js to immediately fall back to Azure AI Search document chunks.
    const isExplicitFinancialMetricQuery = /(net\s+profit|gross\s+profit|operating\s+profit|profit|revenue|ebitda|income|expense|expenses|salary|salaries|headcount)/i.test(q);
    if (isExplicitFinancialMetricQuery && requestedMetrics.length > 0) {
        return [];
    }

    // -----------------------------------------------------------------------
    // PHASE 4: Transaction & Status Heuristics (for operational/settlement queries)
    // -----------------------------------------------------------------------
    const relevant = [];

    // Transaction ID search (e.g. TXN-10004)
    const txnMatch = q.match(/txn-\d+/i);
    if (txnMatch) {
        const targetTxn = txnMatch[0].toUpperCase();
        relevant.push(...periodScopedFacts.filter(f => getEntity(f).toUpperCase().includes(targetTxn)));
    }

    if (q.includes('pending')) {
        relevant.push(...periodScopedFacts.filter(f => /pending/i.test(getEntity(f)) || /pending/i.test(getMetric(f))));
    }

    if (q.includes('approved')) {
        relevant.push(...periodScopedFacts.filter(f => /approved/i.test(getEntity(f)) || /approved/i.test(getMetric(f))));
    }

    if (q.includes('declined')) {
        relevant.push(...periodScopedFacts.filter(f => /declined/i.test(getEntity(f)) || /declined/i.test(getMetric(f))));
    }

    if (q.includes('total') || q.includes('count') || q.includes('amount') || q.includes('summary')) {
        relevant.push(...periodScopedFacts.filter(f => /all transactions/i.test(getEntity(f)) || /total/i.test(getMetric(f))));
    }

    if (q.includes('mismatch') || q.includes('exception') || q.includes('discrepancy') || q.includes('difference') || q.includes('conflict') || q.includes('variance')) {
        relevant.push(...periodScopedFacts.filter(f =>
            /mismatch/i.test(getMetric(f)) ||
            /gateway/i.test(getMetric(f)) ||
            /settlement/i.test(getMetric(f)) ||
            f.hasConflict === true
        ));
    }

    // -----------------------------------------------------------------------
    // PHASE 5: Return relevant or scoped facts (up to 20)
    // -----------------------------------------------------------------------
    const result = relevant.length > 0 ? relevant : periodScopedFacts.slice(0, 20);
    return deduplicateFacts(result);
}

function deduplicateFacts(facts) {
    const seen = new Set();
    const getMetric = f => (f.Metric || f.metric || '');
    const getEntity = f => (f.Entity || f.entity || '');

    return facts.filter(f => {
        const key = f.FactId
            ? String(f.FactId)
            : `${f.DocumentId || ''}_${getMetric(f)}_${getEntity(f)}_${f.NumericValue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatSourceReferences(retrievedChunks, answerText = '') {
    if (!retrievedChunks || retrievedChunks.length === 0) return [];

    const seen = new Set();
    const formatted = [];
    const lowerAnswer = (answerText || '').toLowerCase();

    for (const chunk of retrievedChunks) {
        const sourceName = chunk.fileName || chunk.source || 'Unknown';
        if (seen.has(sourceName)) continue;
        seen.add(sourceName);

        formatted.push({
            source: sourceName,
            isCitedInAnswer: lowerAnswer.includes(sourceName.toLowerCase())
        });
    }

    // If any sources are explicitly cited in the answer, filter to only those cited sources
    // so unrelated files returned by broad semantic search don't pollute the sources list!
    const citedSources = formatted.filter(s => s.isCitedInAnswer);
    const finalSources = citedSources.length > 0 ? citedSources : formatted;

    return finalSources.map((item, idx) => ({
        id: idx + 1,
        source: item.source,
        citation: `[${idx + 1}] ${item.source}`
    }));
}

module.exports = {
    findRelevantStructuredFacts,
    formatSourceReferences,
    BRAND_STOP_WORDS
};