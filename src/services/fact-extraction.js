const { normalizeFinancialValue } = require('./unit-normalizer');

function extractFinancialFacts(normalizedDoc) {
    const facts = [];
    const tables = normalizedDoc.tables || [];
    const fullText = normalizedDoc.fullMarkdown || '';

    // 1. Detect period label if present (English & Arabic)
    let periodLabel = 'Not specified';
    const periodMatch = fullText.match(/(?:reporting\s+period:\s*([^\n\r]+)|(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+to\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})|(?:period|الفترة|فترة\s+التقرير|الربع):\s*([^\n\r]+))/i);
    if (periodMatch) {
        periodLabel = (periodMatch[1] || periodMatch[2] || periodMatch[3] || '').trim();
    }

    // 2. Detect As-Of Date (English & Arabic)
    let asOfDate = null;
    const asOfMatch = fullText.match(/(?:as\s+of|as\s+at|dated?|تاريخ|كما\s+في|بتاريخ):\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|[A-Za-z\u0621-\u064A]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z\u0621-\u064A]+\s+\d{4})/i);
    if (asOfMatch) {
        const parsed = new Date(asOfMatch[1]);
        if (!isNaN(parsed.getTime())) {
            asOfDate = parsed.toISOString().split('T')[0];
        }
    }

    // 3. Detect document-wide currency (Western & Middle-Eastern)
    let docCurrency = 'USD';
    if (/currency:\s*inr|₹|روبية/i.test(fullText)) docCurrency = 'INR';
    else if (/currency:\s*eur|€|يورو/i.test(fullText)) docCurrency = 'EUR';
    else if (/currency:\s*gbp|£|جنيه\s+إسترليني/i.test(fullText)) docCurrency = 'GBP';
    else if (/currency:\s*sar|ريال|ر\.س/i.test(fullText)) docCurrency = 'SAR';
    else if (/currency:\s*aed|درهم|د\.إ/i.test(fullText)) docCurrency = 'AED';
    else if (/currency:\s*egp|جنيه/i.test(fullText)) docCurrency = 'EGP';
    else if (/currency:\s*kwd|دينار/i.test(fullText)) docCurrency = 'KWD';
    else if (/currency:\s*usd|\$|دولار/i.test(fullText)) docCurrency = 'USD';

    // -------------------------------------------------------------------------
    // 4. Process Structured Tables (IFRS, HR & Settlement Tables)
    // -------------------------------------------------------------------------
    for (const table of tables) {
        const headersLower = table.headers.map(h => (h || '').toLowerCase());

        // Settlement table format
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
                        asOfDate,
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
                        asOfDate,
                        numericValue: amountNorm.numericValue,
                        unit: 'amount',
                        currency: amountNorm.currency || docCurrency,
                        sourceLocation: `Settlement summary table; Page ${table.page_number}`,
                        validationStatus: 'Validated'
                    });
                }
            }
        } else if (table.headers && table.headers.length >= 2) {
            // General multi-column financial / HR table (Excel sheets, IFRS statements, headcount/salaries)
            const labelColIdx = 0;
            for (const row of table.rows) {
                const rowLabel = (row.rawValues[labelColIdx] || '').trim();
                if (!rowLabel || rowLabel.length < 2) continue;
                if (/^(sl\.?\s*no|#|id|index|total|subtotal)$/i.test(rowLabel) && row.rawValues.every((v, i) => i === 0 || !v)) continue;

                for (let c = 1; c < table.headers.length; c++) {
                    const colHeader = (table.headers[c] || `Col_${c + 1}`).trim();
                    const cellVal = row.rawValues[c];
                    if (cellVal === undefined || cellVal === null || cellVal === '') continue;

                    const norm = normalizeFinancialValue(cellVal);
                    if (norm.numericValue !== null) {
                        let colPeriod = periodLabel;
                        if (/(\b\d{4}\b|\bQ[1-4]\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|الربع\s+الأول|الربع\s+الثاني|الربع\s+الثالث|الربع\s+الرابع|٢٠\d{2})/i.test(colHeader)) {
                            colPeriod = colHeader;
                        }

                        let unit = norm.unit || 'amount';
                        const isHrMetric = /headcount|employee|employees|staff|workers|turnover\s+count|attrition|salary|salaries|عدد\s+الموظفين|الموظفين|العمالة|الرواتب|الأجور|معدل\s+الدوران/i.test(rowLabel) ||
                                           /headcount|employees|count|عدد\s+الموظفين/i.test(colHeader);
                        if (isHrMetric && !/salary|salaries|الرواتب|الأجور/i.test(rowLabel)) {
                            unit = 'count';
                        }

                        let metricName = rowLabel;
                        if (!/col_\d+/i.test(colHeader) && !/(\b\d{4}\b|\bQ[1-4]\b)/i.test(colHeader)) {
                            metricName = `${rowLabel} - ${colHeader}`;
                        }

                        facts.push({
                            metric: metricName,
                            entity: 'Consolidated',
                            periodLabel: colPeriod,
                            asOfDate,
                            numericValue: norm.numericValue,
                            unit,
                            currency: unit === 'count' ? null : (norm.currency || docCurrency),
                            sourceLocation: `${table.sheetName ? 'Sheet: ' + table.sheetName + '; ' : ''}Table ${table.table_id || 1}, Row ${row.rowIndex || 1}, Col: ${colHeader}`,
                            validationStatus: 'Validated'
                        });
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 5. Process Text-Based Statements, Bullet Metrics & HR Reports
    // -------------------------------------------------------------------------
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
    let currentPage = 1;

    for (const line of lines) {
        const pageMatch = line.match(/<!--\s*Page\s*(\d+)\s*-->/i) || line.match(/Page\s+(\d+)/i);
        if (pageMatch) {
            currentPage = Number(pageMatch[1]);
        }

        // Match bullet metrics: ● Total Revenue: ₹18,50,000 | ● Headcount: 142 | ● Attrition: 4.5%
        const bulletMatch = line.match(/^[●•\-\*]\s*([A-Za-z0-9\sء-ي]+?):\s*([₹$€£]?\s*[0-9,.\u0660-\u0669\u06F0-\u06F9%a-zA-Z\sء-ي]+)/i);
        if (bulletMatch) {
            const rawMetric = bulletMatch[1].trim();
            const valNorm = normalizeFinancialValue(bulletMatch[2]);
            if (valNorm.numericValue !== null && rawMetric.length > 2) {
                // Determine HR vs Financial unit
                let unit = valNorm.unit || 'amount';
                if (/headcount|employee|employees|staff|workers|turnover\s+count|عدد الموظفين/i.test(rawMetric)) {
                    unit = 'count';
                }

                facts.push({
                    metric: rawMetric,
                    entity: 'Consolidated',
                    periodLabel,
                    asOfDate,
                    numericValue: valNorm.numericValue,
                    unit,
                    currency: unit === 'count' ? null : (valNorm.currency || docCurrency),
                    sourceLocation: `Page ${currentPage} - ${rawMetric}`,
                    validationStatus: 'Validated'
                });
            }
            continue;
        }

        // Match table rows: "Software Services 9,50,000" or "Employee Salaries 6,00,000" or "Total Headcount 150"
        const rowMatch = line.match(/^([A-Za-z0-9\sء-ي]{3,40})\s+([0-9,.\u0660-\u0669\u06F0-\u06F9]+)\s*$/);
        if (rowMatch && !/^(page|report|date|status|company|currency|category|amount|invoice|total\s+invoice)/i.test(rowMatch[1])) {
            const rawMetric = rowMatch[1].trim();
            const valNorm = normalizeFinancialValue(rowMatch[2]);
            if (valNorm.numericValue !== null) {
                let unit = valNorm.unit || 'amount';
                if (/headcount|employee|employees|staff|workers|turnover\s+count|عدد الموظفين/i.test(rawMetric)) {
                    unit = 'count';
                }

                facts.push({
                    metric: rawMetric,
                    entity: 'Category Breakdown',
                    periodLabel,
                    asOfDate,
                    numericValue: valNorm.numericValue,
                    unit,
                    currency: unit === 'count' ? null : (valNorm.currency || docCurrency),
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
        const key = `${f.metric.toLowerCase()}::${f.numericValue}::${f.currency || 'null'}`;
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
