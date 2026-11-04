function normalizeFinancialValue(rawInput) {
    if (rawInput === undefined || rawInput === null || rawInput === '') {
        return { numericValue: null, raw: rawInput, scale: 1, unit: null, currency: null };
    }

    if (typeof rawInput === 'number') {
        return { numericValue: Number(rawInput.toFixed(4)), raw: String(rawInput), scale: 1, unit: 'amount', currency: null };
    }

    let str = String(rawInput).trim();

    // 1. Convert Arabic-Indic and Eastern Arabic digits to standard ASCII digits (0-9)
    const arabicIndicMap = {
        '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
        '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
        '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
        '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
        '٫': '.', '٬': ',' // Arabic decimal & thousands separators
    };
    str = str.replace(/[٠-٩۰-۹٫٬]/g, match => arabicIndicMap[match] || match);

    let isNegative = false;
    if (str.startsWith('(') && str.endsWith(')')) {
        isNegative = true;
        str = str.slice(1, -1).trim();
    } else if (str.startsWith('-')) {
        isNegative = true;
        str = str.slice(1).trim();
    }

    // 2. Detect Currency (Western & Middle-Eastern)
    let currency = null;
    const currMatch = str.match(/\b(USD|EUR|GBP|INR|CAD|AUD|SAR|AED|QAR|EGP|KWD|BHD|OMR)\b|\$|€|£|₹|ريال|درهم|جنيه|ر\.س|د\.إ/i);
    if (currMatch) {
        const symbol = currMatch[0];
        if (symbol === '$') currency = 'USD';
        else if (symbol === '€') currency = 'EUR';
        else if (symbol === '£') currency = 'GBP';
        else if (symbol === '₹') currency = 'INR';
        else if (/ريال|ر\.س|SAR/i.test(symbol)) currency = 'SAR';
        else if (/درهم|د\.إ|AED/i.test(symbol)) currency = 'AED';
        else if (/جنيه|EGP/i.test(symbol)) currency = 'EGP';
        else currency = symbol.toUpperCase();
    }

    // 3. Detect Scale & Units (Western & Arabic)
    let scale = 1;
    let unit = 'amount';

    if (/(?:\b(?:billion|bn)\b|(?<=[0-9\s])(?:billion|bn|b)(?=[^a-z]|$)|مليار)/i.test(str)) {
        scale = 1000000000;
    } else if (/(?:\b(?:million|mn)\b|(?<=[0-9\s])(?:million|mn|m)(?=[^a-z]|$)|مليون)/i.test(str)) {
        scale = 1000000;
    } else if (/(?:\b(?:thousand)\b|(?<=[0-9\s])(?:thousand|k)(?=[^a-z]|$)|ألف|الف)/i.test(str)) {
        scale = 1000;
    } else if (/%|percent|بالمائة|في المائة/i.test(str)) {
        unit = 'percentage';
    }

    const cleanNumberStr = str
        .replace(/[$€£₹,]/g, '')
        .replace(/\b(USD|EUR|GBP|INR|CAD|AUD|SAR|AED|QAR|EGP|KWD|BHD|OMR)\b/gi, '')
        .replace(/ريال|درهم|جنيه|ر\.س|د\.إ/gi, '')
        .replace(/(?<=[0-9\s])(?:billion|bn|million|mn|thousand|b|m|k|%)(?=[^a-z]|$)/gi, '')
        .replace(/\b(billion|bn|million|mn|thousand|مليار|مليون|ألف|الف)\b/gi, '')
        .trim();

    const parsed = parseFloat(cleanNumberStr);
    if (isNaN(parsed)) {
        return { numericValue: null, raw: rawInput, scale, unit, currency };
    }

    let finalValue = parsed * scale;
    if (isNegative) finalValue = -finalValue;
    if (unit === 'percentage' && scale === 1) {
        finalValue = Number((finalValue / 100).toFixed(6));
    } else {
        finalValue = Number(finalValue.toFixed(4));
    }

    return {
        numericValue: finalValue,
        raw: rawInput,
        scale,
        unit,
        currency
    };
}

function areValuesEqual(val1, val2, tolerance = 0.001) {
    if (val1 === null || val2 === null || val1 === undefined || val2 === undefined) return false;
    return Math.abs(Number(val1) - Number(val2)) <= tolerance;
}

module.exports = {
    normalizeFinancialValue,
    areValuesEqual
};
