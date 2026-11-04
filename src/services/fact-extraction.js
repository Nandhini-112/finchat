const { normalizeFinancialValue } = require('./unit-normalizer');

function extractFinancialFacts(normalizedDoc) {
    const facts = [];
    const tables = normalizedDoc.tables || [];

    let periodLabel = 'Not specified';
    const periodMatch = (normalizedDoc.fullMarkdown || '').match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+to\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
    if (periodMatch) {
        periodLabel = periodMatch[1];
    }

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
                        currency: amountNorm.currency || 'USD',
                        sourceLocation: `Settlement summary table; Page ${table.page_number}`,
                        validationStatus: 'Validated'
                    });
                }
            }
        }
    }

    return facts;
}

module.exports = {
    extractFinancialFacts
};
