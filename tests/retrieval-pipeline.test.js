const test = require('node:test');
const assert = require('node:assert/strict');
const {
    executeRetrievalPipeline,
    stage1QueryInput,
    stage2QueryPreprocessing,
    stage3IntentClassification,
    stage4QueryValidation,
    stage6ResultFiltering,
    stage7ConflictDetection,
    stage8CalculationPreparation,
    detectLanguage,
    normalizeArabicNumerals,
    resolveConversationalReferences
} = require('../src/services/retrieval-pipeline');

// =========================================================================
// 1. English numerical query -> DIRECT_SQL
// =========================================================================
test('1. English numerical query classifies to DIRECT_SQL with correct metrics', async () => {
    const q = 'What was the net profit for Contoso Properties LLC in Q1 2026?';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s4.intent.route, 'DIRECT_SQL');
    assert.equal(s4.intent.intentType, 'SINGLE_PERIOD_FACT');
    assert.ok(s4.intent.metrics.includes('net profit'));
    assert.ok(s4.intent.entities.some(e => e.toLowerCase().includes('contoso properties')));
    assert.ok(s4.intent.periods.some(p => p.toLowerCase().includes('q1 2026')));
    assert.equal(s2.language, 'en');
});

// =========================================================================
// 2. Arabic numerical query -> DIRECT_SQL
// =========================================================================
test('2. Arabic numerical query classifies to DIRECT_SQL with Arabic language detection', async () => {
    const q = 'ما هي أرباح وإيرادات شركة كونتوسو في الربع الأول ٢٠٢٦؟';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s2.language, 'ar');
    assert.equal(s4.intent.route, 'DIRECT_SQL');
    // Arabic numerals should be normalized
    assert.ok(s2.preprocessedQuestion.includes('2026'));
});

// =========================================================================
// 3. Financial comparison query -> DIRECT_SQL
// =========================================================================
test('3. Financial comparison query classifies to DIRECT_SQL with isComparison=true', async () => {
    const q = 'Compare Q1 2026 vs Q2 2026 revenue for Contoso Retail LLC';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s4.intent.route, 'DIRECT_SQL');
    assert.equal(s4.intent.isComparison, true);
    assert.equal(s4.intent.intentType, 'PERIOD_COMPARISON');
    assert.ok(s4.intent.periods.length >= 2);
});

// =========================================================================
// 4. HR employee-count query -> DIRECT_SQL
// =========================================================================
test('4. HR employee-count and headcount query classifies to DIRECT_SQL', async () => {
    const q = 'What is the total employee count and headcount in Finance for 2026?';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s4.intent.route, 'DIRECT_SQL');
    assert.ok(s4.intent.metrics.some(m => m.includes('employee') || m.includes('headcount')));
});

// =========================================================================
// 5. HR policy query -> AZURE_SEARCH
// =========================================================================
test('5. HR qualitative policy query classifies to AZURE_SEARCH', async () => {
    const q = 'What is the maternity leave policy and remote work procedure?';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s4.intent.route, 'AZURE_SEARCH');
    assert.equal(s4.intent.intentType, 'GENERAL_SEARCH');
});

// =========================================================================
// 6. General narrative document query -> AZURE_SEARCH
// =========================================================================
test('6. General narrative audit observation query classifies to AZURE_SEARCH', async () => {
    const q = 'Summarize the management commentary and internal audit observations.';
    const s1 = stage1QueryInput({ question: q });
    const s2 = stage2QueryPreprocessing(s1);
    const s3 = await stage3IntentClassification(s2);
    const s4 = stage4QueryValidation(s3);

    assert.equal(s4.intent.route, 'AZURE_SEARCH');
});

// =========================================================================
// 7. Query with no matching records -> falls through or empty
// =========================================================================
test('7. Query with no matching records filters out all facts', async () => {
    const stage5Mock = {
        intent: {
            route: 'DIRECT_SQL',
            metrics: ['net profit'],
            entities: ['NonExistentCorp LLC'],
            periods: ['Q1 2026']
        },
        preprocessedQuestion: 'What is the net profit of NonExistentCorp LLC for Q1 2026?',
        rawFacts: [
            {
                FactId: 999,
                Metric: 'Revenue',
                Entity: 'Contoso Retail LLC',
                PeriodLabel: 'Q1 2026',
                NumericValue: 1000000
            }
        ],
        rawChunks: []
    };

    const s6 = await stage6ResultFiltering(stage5Mock);
    assert.equal(s6.retainedFacts.length, 0);
    assert.equal(s6.routeUsed, 'AZURE_SEARCH', 'Should fallback to AZURE_SEARCH when 0 facts retained');
});

// =========================================================================
// 8. Query involving conflicting financial facts -> hasUnresolvedConflict=true
// =========================================================================
test('8. Query involving conflicting financial facts detects unresolved equal-rank conflict', () => {
    const stage6Mock = {
        routeUsed: 'DIRECT_SQL',
        preprocessedQuestion: 'What is the net profit for Contoso Properties LLC in Q1 2026?',
        retainedFacts: [
            {
                FactId: 1,
                Metric: 'Net profit for the period',
                Entity: 'Contoso Properties LLC',
                PeriodLabel: 'Q1 2026',
                NumericValue: 640276,
                Currency: 'AED',
                SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
                AuthorityRank: 4,
                AuthorityType: 'Sample / Test',
                hasConflict: true,
                conflictStatus: 'Unresolved - Review Required',
                conflictExplanation: 'Equal-rank disagreement: Difference 666848.'
            },
            {
                FactId: 2,
                Metric: 'Net profit for the period',
                Entity: 'Contoso Properties LLC',
                PeriodLabel: 'Q1 2026',
                NumericValue: 1307124,
                Currency: 'AED',
                SourceFileName: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf',
                AuthorityRank: 4,
                AuthorityType: 'Sample / Test',
                hasConflict: true,
                conflictStatus: 'Unresolved - Review Required',
                conflictExplanation: 'Equal-rank disagreement: Difference 666848.'
            }
        ]
    };

    const s7 = stage7ConflictDetection(stage6Mock);
    assert.equal(s7.hasUnresolvedConflict, true);
    assert.ok(s7.conflictAnswer.includes('⚠️'));
    assert.ok(s7.conflictAnswer.includes('Unresolved - Review Required'));
});

// =========================================================================
// 9. Conversational reference resolution in Stage 2
// =========================================================================
test('9. Resolves conversational follow-up references using conversation history', () => {
    const history = [
        { role: 'user', content: 'What was the revenue for Contoso Logistics LLC in Q1 2026?' },
        { role: 'assistant', content: 'Revenue was AED 8,720,000.' }
    ];

    const followUp = 'What about gross profit?';
    const s1 = stage1QueryInput({ question: followUp });
    const s2 = stage2QueryPreprocessing(s1, history);

    assert.ok(s2.preprocessedQuestion.includes('Contoso Logistics'));
});

// =========================================================================
// 10. Calculation preparation in Stage 8
// =========================================================================
test('10. Calculation preparation computes period variances for comparison queries', () => {
    const stage7Mock = {
        routeUsed: 'DIRECT_SQL',
        intent: {
            isComparison: true,
            periods: ['Q1 2026', 'Q2 2026'],
            metrics: ['revenue']
        },
        preprocessedQuestion: 'Compare Q1 2026 vs Q2 2026 revenue',
        retainedFacts: [
            {
                FactId: 1,
                Metric: 'Revenue',
                PeriodLabel: 'Q1 2026',
                NumericValue: 1000,
                Currency: 'AED'
            },
            {
                FactId: 2,
                Metric: 'Revenue',
                PeriodLabel: 'Q2 2026',
                NumericValue: 1200,
                Currency: 'AED'
            }
        ]
    };

    const s8 = stage8CalculationPreparation(stage7Mock);
    assert.equal(s8.calculations.length, 1);
    assert.equal(s8.calculations[0].type, 'PERIOD_COMPARISON');
    assert.equal(s8.calculations[0].difference, 200);
});

// =========================================================================
// 11. Existing API response compatibility verification
// =========================================================================
test('11. Response delivery contract preserves all required properties', async () => {
    const { stage11LoggingAndDelivery } = require('../src/services/retrieval-pipeline');

    const stage10Mock = {
        routeUsed: 'DIRECT_SQL',
        intent: { intentType: 'SINGLE_PERIOD_FACT', entities: ['Contoso Retail'], periods: ['Q1 2026'], metrics: ['revenue'] },
        answer: 'Contoso Retail revenue was AED 12,480,000.',
        hasUnresolvedConflict: false,
        resolvedDocumentId: 10,
        documentName: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf',
        pageNumber: 1,
        formattedSources: [{ id: 1, source: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf', citation: '[1] 01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf' }],
        factsUsedOutput: [{ metric: 'Revenue', value: 12480000 }],
        calculations: [],
        insufficientEvidence: false,
        language: 'en',
        grounded: true
    };

    const response = stage11LoggingAndDelivery(stage10Mock, 'test-corr-id');

    // Strict check on all properties required by retrieval.md Section 4
    assert.equal(response.status, 'success');
    assert.equal(typeof response.answer, 'string');
    assert.equal(response.language, 'en');
    assert.equal(response.grounded, true);
    assert.ok(Array.isArray(response.sources));
    assert.equal(response.document_name, '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf');
    assert.equal(response.page, 1);

    // Existing fields check
    assert.equal(response.routeUsed, 'DIRECT_SQL');
    assert.equal(response.intentType, 'SINGLE_PERIOD_FACT');
    assert.deepEqual(response.entitiesDetected, ['Contoso Retail']);
    assert.deepEqual(response.periodsDetected, ['Q1 2026']);
    assert.deepEqual(response.metricsDetected, ['revenue']);
    assert.equal(response.hasUnresolvedConflict, false);
    assert.equal(response.documentId, 10);
    assert.ok(Array.isArray(response.factsUsed));
    assert.ok(Array.isArray(response.calculations));
    assert.equal(response.insufficientEvidence, false);
    assert.equal(response.correlationId, 'test-corr-id');
});
