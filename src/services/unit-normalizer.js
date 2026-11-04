function normalizeFinancialValue(rawInput) {
    if (rawInput === undefined || rawInput === null || rawInput === '') {
        return { numericValue: null, raw: rawInput, scale: 1, unit: null, currency: null };
    }

    if (typeof rawInput === 'number') {
        return { numericValue: Number(rawInput.toFixed(4)), raw: String(rawInput), scale: 1, unit: 'amount', currency: null };
    }

    let str = String(rawInput).trim();
    let isNegative = false;
    if (str.startsWith('(') && str.endsWith(')')) {
        isNegative = true;
        str = str.slice(1, -1).trim();
    } else if (str.startsWith('-')) {
        isNegative = true;
        str = str.slice(1).trim();
    }

    let currency = null;
    const currMatch = str.match(/\b(USD|EUR|GBP|INR|CAD|AUD)\b|\$|€|£|₹/i);
    if (currMatch) {
        const symbol = currMatch[0].toUpperCase();
        if (symbol === '$') currency = 'USD';
        else if (symbol === '€') currency = 'EUR';
        else if (symbol === '£') currency = 'GBP';
        else if (symbol === '₹') currency = 'INR';
        else currency = symbol;
    }

    let scale = 1;
    let unit = 'amount';

    if (/(?:\b(?:billion|bn)\b|(?<=[0-9\s])(?:billion|bn|b)(?=[^a-z]|$))/i.test(str)) {
        scale = 1000000000;
    } else if (/(?:\b(?:million|mn)\b|(?<=[0-9\s])(?:million|mn|m)(?=[^a-z]|$))/i.test(str)) {
        scale = 1000000;
    } else if (/(?:\b(?:thousand)\b|(?<=[0-9\s])(?:thousand|k)(?=[^a-z]|$))/i.test(str)) {
        scale = 1000;
    } else if (/%|percent/i.test(str)) {
        unit = 'percentage';
    }

    const cleanNumberStr = str
        .replace(/[$€£₹,]/g, '')
        .replace(/\b(USD|EUR|GBP|INR|CAD|AUD)\b/gi, '')
        .replace(/(?<=[0-9\s])(?:billion|bn|million|mn|thousand|b|m|k|%)(?=[^a-z]|$)/gi, '')
        .replace(/\b(billion|bn|million|mn|thousand)\b/gi, '')
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
