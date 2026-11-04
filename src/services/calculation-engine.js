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

/**
 * Deterministically computes period-over-period comparison variance across 2 dates/periods.
 */
function computePeriodComparison(facts = [], period1 = '', period2 = '') {
    const comparisons = [];
    if (!facts || facts.length === 0) return comparisons;

    const p1 = (period1 || '').toLowerCase();
    const p2 = (period2 || '').toLowerCase();

    // Group facts by metric
    const byMetric = new Map();
    for (const f of facts) {
        if (f.NumericValue !== null) {
            const m = (f.Metric || '').trim();
            if (!byMetric.has(m)) byMetric.set(m, []);
            byMetric.get(m).push(f);
        }
    }

    for (const [metric, metricFacts] of byMetric.entries()) {
        let fact1 = null;
        let fact2 = null;

        if (p1 && p2) {
            fact1 = metricFacts.find(f => (f.PeriodLabel || '').toLowerCase().includes(p1) || (f.SourceLocation || '').toLowerCase().includes(p1));
            fact2 = metricFacts.find(f => (f.PeriodLabel || '').toLowerCase().includes(p2) || (f.SourceLocation || '').toLowerCase().includes(p2));
        }

        // If specific period match wasn't found by label, compare first two distinct periods
        if (!fact1 || !fact2) {
            if (metricFacts.length >= 2) {
                fact1 = metricFacts[0];
                fact2 = metricFacts[1];
            }
        }

        if (fact1 && fact2 && fact1.FactId !== fact2.FactId) {
            const v1 = parseFloat(fact1.NumericValue);
            const v2 = parseFloat(fact2.NumericValue);
            const diff = Number((v2 - v1).toFixed(4));
            let pct = null;
            if (v1 !== 0) {
                pct = Number((((v2 - v1) / Math.abs(v1)) * 100).toFixed(2));
            }

            comparisons.push({
                type: 'PERIOD_COMPARISON',
                metric,
                period1: fact1.PeriodLabel || period1 || 'Period 1',
                period1Value: v1,
                period2: fact2.PeriodLabel || period2 || 'Period 2',
                period2Value: v2,
                difference: diff,
                percentChange: pct,
                currency: fact1.Currency || fact2.Currency || 'USD',
                direction: diff > 0 ? 'Increase' : (diff < 0 ? 'Decrease' : 'Unchanged')
            });
        }
    }

    return comparisons;
}

function evaluateDeterministicCalculations(question, facts = [], intentContext = null) {
    if (!facts || facts.length === 0) return [];
    const q = question.toLowerCase();
    const calculations = [];

    // 1. Explicit multi-period comparison if intent requested comparison
    if (intentContext && intentContext.isComparison && intentContext.periods && intentContext.periods.length >= 2) {
        const periodCalcs = computePeriodComparison(facts, intentContext.periods[0], intentContext.periods[1]);
        if (periodCalcs.length > 0) {
            calculations.push(...periodCalcs);
        }
    }

    // 2. Gateway vs Settlement Discrepancy
    const isDiscrepancyQuery = q.includes('mismatch') || q.includes('discrepancy') || q.includes('difference') || q.includes('gateway') || q.includes('settlement');
    if (isDiscrepancyQuery) {
        const gwFacts = facts.filter(f => /gateway/i.test(f.Metric));
        const setFacts = facts.filter(f => /settlement/i.test(f.Metric) || (/transaction amount/i.test(f.Metric) && f.Entity === 'Approved'));

        if (gwFacts.length > 0 && setFacts.length > 0) {
            const discCalc = computeReconciliationDiscrepancy(gwFacts[0], setFacts[0]);
            if (discCalc) calculations.push(discCalc);
        }
    }

    // 3. Category Sum vs Stated Total
    const isSumQuery = q.includes('sum') || q.includes('total') || q.includes('breakdown') || q.includes('categories') || q.includes('components');
    if (isSumQuery) {
        const countComponents = facts.filter(f => f.Metric === 'Transaction Count' && ['Approved', 'Declined', 'Pending'].includes(f.Entity));
        const totalCount = facts.find(f => f.Metric === 'Transaction Count' && f.Entity === 'All Transactions');
        if (countComponents.length > 0) {
            const countSumCalc = computeCategorySum(countComponents, totalCount);
            if (countSumCalc) calculations.push(countSumCalc);
        }

        const amountComponents = facts.filter(f => f.Metric === 'Transaction Amount' && ['Approved', 'Declined', 'Pending'].includes(f.Entity));
        const totalAmount = facts.find(f => f.Metric === 'Transaction Amount' && f.Entity === 'All Transactions');
        if (amountComponents.length > 0) {
            const amountSumCalc = computeCategorySum(amountComponents, totalAmount);
            if (amountSumCalc) calculations.push(amountSumCalc);
        }
    }

    // 4. Period-over-period or multi-source variance fallback
    const isVarianceQuery = q.includes('variance') || q.includes('growth') || q.includes('compare') || q.includes('change') || q.includes('increase') || q.includes('decrease');
    if (isVarianceQuery && calculations.length === 0) {
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
    computePeriodComparison,
    evaluateDeterministicCalculations
};
