const { areValuesEqual } = require('./unit-normalizer');

function computeVariance(factA, factB) {
    if (!factA || !factB || factA.NumericValue === null || factB.NumericValue === null) {
        return null;
    }

    const valA = parseFloat(factA.NumericValue);
    const valB = parseFloat(factB.NumericValue);

    const difference = Number((valB - valA).toFixed(4));
    let percentChange = null;

    if (valA !== 0) {
        percentChange = Number((((valB - valA) / Math.abs(valA)) * 100).toFixed(2));
    }

    return {
        type: 'VARIANCE',
        metric: factA.Metric,
        entity: factA.Entity,
        basePeriod: factA.PeriodLabel,
        baseValue: valA,
        comparisonPeriod: factB.PeriodLabel,
        comparisonValue: valB,
        difference,
        percentChange,
        currency: factA.Currency || factB.Currency || 'USD',
        unit: factA.Unit || factB.Unit || 'amount',
        formula: `(${valB} - ${valA}) = ${difference}`
    };
}

function computeCategorySum(componentFacts, totalFact = null) {
    if (!componentFacts || componentFacts.length === 0) return null;

    let calculatedSum = 0;
    const components = [];

    for (const f of componentFacts) {
        if (f.NumericValue !== null) {
            const v = parseFloat(f.NumericValue);
            calculatedSum += v;
            components.push({
                entity: f.Entity,
                metric: f.Metric,
                value: v
            });
        }
    }

    calculatedSum = Number(calculatedSum.toFixed(4));
    const result = {
        type: 'CATEGORY_SUM',
        metric: componentFacts[0].Metric,
        components,
        calculatedTotal: calculatedSum,
        statedTotal: totalFact && totalFact.NumericValue !== null ? parseFloat(totalFact.NumericValue) : null,
        currency: componentFacts[0].Currency || 'USD',
        unit: componentFacts[0].Unit || 'amount'
    };

    if (result.statedTotal !== null) {
        result.matchesStated = areValuesEqual(calculatedSum, result.statedTotal, 0.01);
        result.variance = Number((calculatedSum - result.statedTotal).toFixed(4));
    }

    return result;
}

function computeReconciliationDiscrepancy(gatewayFact, settlementFact) {
    if (!gatewayFact || !settlementFact) return null;

    const gwVal = parseFloat(gatewayFact.NumericValue);
    const setVal = parseFloat(settlementFact.NumericValue);
    const difference = Number((gwVal - setVal).toFixed(4));
    const hasDiscrepancy = Math.abs(difference) > 0.005;

    return {
        type: 'RECONCILIATION_DISCREPANCY',
        entity: gatewayFact.Entity,
        gatewayAmount: gwVal,
        settlementAmount: setVal,
        discrepancy: Math.abs(difference),
        differenceSigned: difference,
        currency: gatewayFact.Currency || settlementFact.Currency || 'USD',
        hasDiscrepancy,
        status: hasDiscrepancy ? 'AMOUNT_MISMATCH' : 'MATCHED'
    };
}

function evaluateDeterministicCalculations(question, facts = []) {
    if (!facts || facts.length === 0) return [];
    const q = question.toLowerCase();
    const calculations = [];

    // 1. Gateway vs Settlement Discrepancy
    const isDiscrepancyQuery = q.includes('mismatch') || q.includes('discrepancy') || q.includes('difference') || q.includes('gateway') || q.includes('settlement');
    if (isDiscrepancyQuery) {
        const gwFacts = facts.filter(f => /gateway/i.test(f.Metric));
        const setFacts = facts.filter(f => /settlement/i.test(f.Metric) && !/summary/i.test(f.Metric));

        for (const gw of gwFacts) {
            const matchSet = setFacts.find(s => s.Entity === gw.Entity);
            if (matchSet) {
                const calc = computeReconciliationDiscrepancy(gw, matchSet);
                if (calc) calculations.push(calc);
            }
        }
    }

    // 2. Component breakdowns (Approved + Declined + Pending vs Total)
    const isSumQuery = q.includes('total') || q.includes('sum') || q.includes('aggregate') || q.includes('all transactions');
    if (isSumQuery) {
        const countComponents = facts.filter(f => f.Metric === 'Transaction Count' && ['Approved', 'Declined', 'Pending'].includes(f.Entity));
        const totalCount = facts.find(f => f.Metric === 'Transaction Count' && f.Entity === 'All Transactions');
        if (countComponents.length > 0) {
            const sumCalc = computeCategorySum(countComponents, totalCount);
            if (sumCalc) calculations.push(sumCalc);
        }

        const amountComponents = facts.filter(f => f.Metric === 'Transaction Amount' && ['Approved', 'Declined', 'Pending'].includes(f.Entity));
        const totalAmount = facts.find(f => f.Metric === 'Transaction Amount' && f.Entity === 'All Transactions');
        if (amountComponents.length > 0) {
            const amountSumCalc = computeCategorySum(amountComponents, totalAmount);
            if (amountSumCalc) calculations.push(amountSumCalc);
        }
    }

    // 3. Period-over-period or multi-source variance
    const isVarianceQuery = q.includes('variance') || q.includes('growth') || q.includes('compare') || q.includes('change') || q.includes('increase') || q.includes('decrease');
    if (isVarianceQuery) {
        const groups = new Map();
        for (const f of facts) {
            if (f.NumericValue !== null) {
                const key = `${(f.Metric || '').trim().toLowerCase()}|${(f.Entity || 'global').trim().toLowerCase()}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(f);
            }
        }

        for (const [, groupFacts] of groups.entries()) {
            if (groupFacts.length >= 2) {
                const vCalc = computeVariance(groupFacts[0], groupFacts[1]);
                if (vCalc) calculations.push(vCalc);
            }
        }
    }

    return calculations;
}

module.exports = {
    computeVariance,
    computeCategorySum,
    computeReconciliationDiscrepancy,
    evaluateDeterministicCalculations
};
