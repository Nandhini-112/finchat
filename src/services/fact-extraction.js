const { normalizeFinancialValue } = require('./unit-normalizer');

function extractFinancialFacts(normalizedDoc) {
    const facts = [];
    const tables = normalizedDoc.tables || [];
    const fullText = normalizedDoc.fullMarkdown || '';

    // Detect period label if present
    let periodLabel = 'Not specified';
    const periodMatch = fullText.match(/(?:reporting\s+period:\s*([^\n\r]+)|(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+to\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}))/i);
    if (periodMatch) {
        periodLabel = (periodMatch[1] || periodMatch[2] || '').trim();
    }

    // Detect document-wide currency
    let docCurrency = 'USD';
    if (/currency:\s*inr|₹/i.test(fullText)) docCurrency = 'INR';
    else if (/currency:\s*eur|€/i.test(fullText)) docCurrency = 'EUR';
    else if (/currency:\s*gbp|£/i.test(fullText)) docCurrency = 'GBP';

    // 1. Process Structured Tables (Settlement & Financial Tables)
    for (const table of tables) {
        const headersLower = table.headers.map(h => (h || '').toLowerCase());

        const isSummaryTable = headersLower.some(h => h.includes('metric')) &&
            headersLower.some(h => h.includes('count') || h.includes('amount'));

        if (isSummaryTable) {
            const metricIdx = headersLower.findIndex(h => h.includes('metric'));
            const countIdx = headersLower.findIndex(h => h.includes('count'));
            const amountIdx = headersLower.findIndex(h => h.includes('amount'));

            for (const row of table.rows) {
                const metricName = row.rawValues[metricIdx] || '';
                const rawCount = countIdx !== -1 ? row.rawValues[countIdx] : null;
                const rawAmount = amountIdx !== -1 ? row.rawValues[amountIdx] : null;

                const countNorm = normalizeFinancialValue(rawCount);
                const amountNorm = normalizeFinancialValue(rawAmount);

                let entity = 'All Transactions';
                if (/approved/i.test(metricName)) entity = 'Approved';
                else if (/declined/i.test(metricName)) entity = 'Declined';
                else if (/pending/i.test(metricName)) entity = 'Pending';
                else if (/total/i.test(metricName)) entity = 'All Transactions';
                else entity = metricName.trim();

                if (countNorm.numericValue !== null) {
                    facts.push({
                        metric: 'Transaction Count',
                        entity,
                        periodLabel,
                        numericValue: countNorm.numericValue,
                        unit: 'count',
                        currency: null,
                        sourceLocation: `Settlement summary table; Page ${table.page_number}`,
                        validationStatus: 'Validated'
                    });
                }

                if (amountNorm.numericValue !== null) {
                    facts.push({
                        metric: 'Transaction Amount',
                        entity,
                        periodLabel,
                        numericValue: amountNorm.numericValue,
                        unit: 'amount',
                        currency: amountNorm.currency || docCurrency,
                        sourceLocation: `Settlement summary table; Page ${table.page_number}`,
                        validationStatus: 'Validated'
                    });
                }
            }
        }
    }

    // 2. Process Text-Based Statements & Tabular Lines
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
    let currentPage = 1;

    for (const line of lines) {
        const pageMatch = line.match(/<!--\s*Page\s*(\d+)\s*-->/i) || line.match(/Page\s+(\d+)/i);
        if (pageMatch) {
            currentPage = Number(pageMatch[1]);
        }

        // Match bullet metrics: ● Total Revenue: ₹18,50,000  or  - Net Profit: 9,50,000
        const bulletMatch = line.match(/^[●•\-\*]\s*([A-Za-z0-9\s]+?):\s*([₹$€£]?\s*[0-9,.]+)/i);
        if (bulletMatch) {
            const rawMetric = bulletMatch[1].trim();
            const valNorm = normalizeFinancialValue(bulletMatch[2]);
            if (valNorm.numericValue !== null && rawMetric.length > 2) {
                facts.push({
                    metric: rawMetric,
                    entity: 'Consolidated',
                    periodLabel,
                    numericValue: valNorm.numericValue,
                    unit: 'amount',
                    currency: valNorm.currency || docCurrency,
                    sourceLocation: `Page ${currentPage} - ${rawMetric}`,
                    validationStatus: 'Validated'
                });
            }
            continue;
        }

        // Match table rows: "Software Services 9,50,000" or "Employee Salaries 6,00,000"
        const rowMatch = line.match(/^([A-Za-z\s]{3,35})\s+([0-9,.]+)\s*$/);
        if (rowMatch && !/^(page|report|date|status|company|currency|category|amount|invoice|total\s+invoice)/i.test(rowMatch[1])) {
            const rawMetric = rowMatch[1].trim();
            const valNorm = normalizeFinancialValue(rowMatch[2]);
            if (valNorm.numericValue !== null && valNorm.numericValue >= 100) {
                facts.push({
                    metric: rawMetric,
                    entity: 'Category Breakdown',
                    periodLabel,
                    numericValue: valNorm.numericValue,
                    unit: 'amount',
                    currency: valNorm.currency || docCurrency,
                    sourceLocation: `Page ${currentPage} - Table Row`,
                    validationStatus: 'Validated'
                });
            }
        }
    }

    // Deduplicate identical metric values within the same document
    const seen = new Set();
    const uniqueFacts = [];
    for (const f of facts) {
        const key = `${f.metric.toLowerCase()}::${f.numericValue}::${f.currency}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueFacts.push(f);
        }
    }

    return uniqueFacts;
}

module.exports = {
    extractFinancialFacts
};
