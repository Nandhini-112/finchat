const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEntitiesFromQuestion, classifyIntentByRules, extractMetricsFromQuestion } = require('../src/services/intent-classifier');
const { findRelevantStructuredFacts, formatSourceReferences } = require('../src/services/evidence-validation');
const { buildConflictAnswer, appendConflictDetailsToAnswer } = require('../src/services/answer-generation');
const { validateRetrievalResponse, deduplicateFactsUsed } = require('../src/services/response-validator');

test('extractEntitiesFromQuestion extracts Contoso entities and corporate designations', () => {
    const q1 = 'What is the net profit for Contoso Properties LLC for Q1 2026?';
    const entities1 = extractEntitiesFromQuestion(q1);
    assert.ok(entities1.some(e => e.toLowerCase().includes('contoso properties')));

    const q2 = 'Compare Contoso Retail and Contoso Logistics revenue';
    const entities2 = extractEntitiesFromQuestion(q2);
    assert.ok(entities2.some(e => e.toLowerCase().includes('contoso retail')));
    assert.ok(entities2.some(e => e.toLowerCase().includes('contoso logistics')));

    const q3 = 'What is the total revenue of Acme Corp for FY 2025?';
    const entities3 = extractEntitiesFromQuestion(q3);
    assert.ok(entities3.some(e => e.toLowerCase().includes('acme corp')));
});

test('classifyIntentByRules extracts entities and periods from query without documentId', () => {
    const intent = classifyIntentByRules('What is the net profit for Contoso Properties LLC for Q1 2026?');
    assert.equal(intent.route, 'DIRECT_SQL');
    assert.equal(intent.intentType, 'SINGLE_PERIOD_FACT');
    assert.ok(intent.entities.length > 0);
    assert.ok(intent.entities.some(e => e.toLowerCase().includes('contoso properties')));
    assert.ok(intent.periods.some(p => p.toLowerCase().includes('q1 2026')));
});

test('findRelevantStructuredFacts scopes by entity and matches requested metric', () => {
    const mixedFacts = [
        {
            FactId: 101,
            Metric: 'Cash and bank balances',
            Entity: 'Consolidated',
            PeriodLabel: 'Not specified',
            NumericValue: 450000,
            SourceFileName: 'eample document.pdf'
        },
        {
            FactId: 102,
            Metric: 'Inventory',
            Entity: 'Consolidated',
            PeriodLabel: 'Not specified',
            NumericValue: 320000,
            SourceFileName: 'eample document.pdf'
        },
        {
            FactId: 103,
            Metric: 'Total Transactions',
            Entity: 'All Transactions',
            PeriodLabel: '01 October 2026 to 07 October 2026',
            NumericValue: 8,
            SourceFileName: 'sample_transaction_report_mixed_format.pdf'
        },
        {
            FactId: 201,
            Metric: 'Net Profit',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 1250000,
            SourceFileName: '05_Contoso_Properties_Income_Statement_Q1_2026.pdf'
        },
        {
            FactId: 202,
            Metric: 'Total Revenue',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 5600000,
            SourceFileName: '05_Contoso_Properties_Income_Statement_Q1_2026.pdf'
        }
    ];

    const question = 'What is the net profit for Contoso Properties LLC for Q1 2026?';
    const intent = classifyIntentByRules(question);

    const relevant = findRelevantStructuredFacts(question, mixedFacts, intent);

    // Should prioritize the exact Net Profit fact
    assert.equal(relevant.length, 1);
    assert.equal(relevant[0].Metric, 'Net Profit');
    assert.equal(relevant[0].SourceFileName, '05_Contoso_Properties_Income_Statement_Q1_2026.pdf');
    assert.equal(relevant[0].NumericValue, 1250000);
});

test('findRelevantStructuredFacts returns empty array if target entity only has unrelated balance sheet facts (triggers fallback to Azure Search)', () => {
    const onlyBalanceSheetFacts = [
        {
            FactId: 101,
            Metric: 'Cash and bank balances',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Not specified',
            NumericValue: 450000,
            SourceFileName: 'contoso_properties_balance_sheet.pdf'
        },
        {
            FactId: 102,
            Metric: 'Accounts receivable',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Not specified',
            NumericValue: 280000,
            SourceFileName: 'contoso_properties_balance_sheet.pdf'
        },
        {
            FactId: 103,
            Metric: 'Inventory',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Not specified',
            NumericValue: 320000,
            SourceFileName: 'contoso_properties_balance_sheet.pdf'
        }
    ];

    const question = 'What is the net profit for Contoso Properties LLC for Q1 2026?';
    const intent = classifyIntentByRules(question);

    const relevant = findRelevantStructuredFacts(question, onlyBalanceSheetFacts, intent);

    // Must return [] so chat.js falls back to Azure AI Search chunks to find the income statement
    // instead of giving the LLM unrelated Cash/Inventory items!
    assert.equal(relevant.length, 0);
});

test('findRelevantStructuredFacts returns empty array if target entity is not in SQL facts', () => {
    const onlyUnrelatedFacts = [
        {
            FactId: 101,
            Metric: 'Cash and bank balances',
            Entity: 'Consolidated',
            PeriodLabel: 'Not specified',
            NumericValue: 450000,
            SourceFileName: 'eample document.pdf'
        },
        {
            FactId: 103,
            Metric: 'Total Transactions',
            Entity: 'All Transactions',
            PeriodLabel: '01 October 2026 to 07 October 2026',
            NumericValue: 8,
            SourceFileName: 'sample_transaction_report_mixed_format.pdf'
        }
    ];

    const question = 'What is the net profit for Contoso Properties LLC for Q1 2026?';
    const intent = classifyIntentByRules(question);

    const relevant = findRelevantStructuredFacts(question, onlyUnrelatedFacts, intent);

    assert.equal(relevant.length, 0);
});

test('answer-generation enforces token budgets to prevent 413 rate limit errors', () => {
    const {
        MAX_OUTPUT_TOKENS,
        MAX_CHUNK_CONTENT_CHARS,
        MAX_CHUNKS_COUNT,
        MAX_FACTS_COUNT,
        MAX_TOTAL_EVIDENCE_CHARS
    } = require('../src/services/answer-generation');

    assert.ok(MAX_OUTPUT_TOKENS <= 1000, 'Output tokens must not exceed 1000');
    assert.ok(MAX_TOTAL_EVIDENCE_CHARS <= 8000, 'Total evidence chars must not exceed 8000 (~2000 tokens)');
    assert.ok(MAX_CHUNK_CONTENT_CHARS <= 1500, 'Each chunk must be capped to <= 1500 chars');
    assert.ok(MAX_CHUNKS_COUNT <= 3, 'Chunks count must be capped to <= 3');
    assert.ok(MAX_FACTS_COUNT <= 10, 'Facts count must be capped to <= 10');
});

test('formatSourceReferences returns clean sources without URLs, chunk IDs, or queue keys', () => {
    const rawChunks = [
        {
            source: 'Monthly financial report  testing.pdf.pdf',
            fileLink: 'https://idealtechlab.sharepoint.com/sites/ITL-Trainee/Shared%20Documents/metadataextraction/Monthly%20financial%20report%20%20testing.pdf.pdf',
            id: 'qk_b_4so4PUAfMU2z6Q2Xw-V4jL23dqUHa8JJsEu13p-izR4UWlnfSeyPQ4OY6ywQV9iF_01FYFOW2OQAGB_eacd9330fcd726e5b5ba_c16',
            title: 'Monthly financial report  testing.pdf.pdf - 1. What was the total revenue in January 2026?',
            pageNumber: 1,
            department: null,
            jobTitle: null,
            authorityRank: 4,
            authoritySource: 'DocumentRank',
            documentKey: 'b!4so4PUAfMU2z6Q2Xw-V4jL23dqUHa8JJsEu13p-izR4UWlnfSeyPQ4OY6ywQV9iF|01FYFOW2OQAGBVMJZKLNCY2K5HSDMDBA2I',
            queueKey: 'b!4so4PUAfMU2z6Q2Xw-V4jL23dqUHa8JJsEu13p-izR4UWlnfSeyPQ4OY6ywQV9iF|01FYFOW2OQAGBVMJZKLNCY2K5HSDMDBA2I|1.0'
        },
        {
            source: 'Monthly financial report  testing.pdf.pdf',
            fileLink: 'https://idealtechlab.sharepoint.com/...',
            id: 'qk_c17',
            title: 'Monthly financial report  testing.pdf.pdf - Page 2',
            pageNumber: 2
        }
    ];

    const sources = formatSourceReferences(rawChunks);

    assert.equal(sources.length, 1, 'Should deduplicate by source filename');
    assert.deepEqual(sources[0], {
        id: 1,
        source: 'Monthly financial report  testing.pdf.pdf',
        citation: '[1] Monthly financial report  testing.pdf.pdf'
    });
    assert.equal(sources[0].fileLink, undefined);
    assert.equal(sources[0].chunkId, undefined);
    assert.equal(sources[0].documentKey, undefined);
    assert.equal(sources[0].queueKey, undefined);
});

test('findRelevantStructuredFacts does not match Retail or Logistics when entity is Contoso Properties LLC', () => {
    const multiEntityFacts = [
        {
            FactId: 1,
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 1307124,
            SourceFileName: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf'
        },
        {
            FactId: 2,
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 895895,
            SourceFileName: '03_Contoso_Logistics_Income_Statement_Q1_2026_Audited.pdf'
        },
        {
            FactId: 3,
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 640276,
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf'
        }
    ];

    const intent = {
        entities: ['Contoso properties LLC'],
        periods: ['Q1 2026'],
        metrics: ['net profit']
    };

    const relevant = findRelevantStructuredFacts('What is the net profit for Contoso Properties LLC for Q1 2026?', multiEntityFacts, intent);

    assert.equal(relevant.length, 1);
    assert.equal(relevant[0].SourceFileName, '06_Contoso_Properties_Management_Pack_Q1_2026.pdf');
    assert.equal(relevant[0].NumericValue, 640276);
});

test('formatSourceReferences filters to the document cited in the generated answer', () => {
    const chunks = [
        { source: 'Monthly financial report  testing.pdf.pdf', pageNumber: 1 },
        { source: 'document_1794385407426.pdf', pageNumber: 1 },
        { source: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf', pageNumber: 2 }
    ];

    const answer = 'Contoso Properties LLC net profit for Q1 2026 was AED 640,276. Source: "06_Contoso_Properties_Management_Pack_Q1_2026.pdf"';

    const sources = formatSourceReferences(chunks, answer);

    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, '06_Contoso_Properties_Management_Pack_Q1_2026.pdf');
});


// ============================================================
// METRIC EXTRACTION TESTS
// ============================================================

test('extractMetricsFromQuestion detects net profit', () => {
    const metrics = extractMetricsFromQuestion('What is the net profit for Contoso Properties LLC for Q1 2026?');
    assert.ok(metrics.includes('net profit'), `Expected "net profit" in [${metrics}]`);
});

test('extractMetricsFromQuestion detects gross profit and revenue independently', () => {
    const metrics = extractMetricsFromQuestion('What was the gross profit and total revenue for Q2?');
    assert.ok(metrics.includes('gross profit'), `Expected "gross profit" in [${metrics}]`);
    assert.ok(metrics.includes('total revenue') || metrics.includes('revenue'), `Expected "revenue" in [${metrics}]`);
});

test('extractMetricsFromQuestion detects operating expenses', () => {
    const metrics = extractMetricsFromQuestion('Show me the operating expenses for Contoso Retail in Q1 2026');
    assert.ok(metrics.some(m => m.includes('operating expenses') || m.includes('expenses')), `Expected expenses in [${metrics}]`);
});

test('classifyIntentByRules populates metrics[] from query text', () => {
    const intent = classifyIntentByRules('What is the net profit for Contoso Properties LLC for Q1 2026?');
    assert.ok(Array.isArray(intent.metrics), 'metrics should be an array');
    assert.ok(intent.metrics.length > 0, 'metrics should not be empty');
    assert.ok(intent.metrics.includes('net profit'), `Expected "net profit" in [${intent.metrics}]`);
});

// ============================================================
// CONFLICT-AWARE ANSWER TESTS
// ============================================================

test('buildConflictAnswer returns structured conflict report for unresolved conflicts', () => {
    const conflictFacts = [
        {
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
            conflictExplanation: 'Equal-rank disagreement for Net profit. Source A reports 640276 AED, Source B reports 1307124 AED. Difference: 666848.'
        },
        {
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
            conflictExplanation: 'Equal-rank disagreement for Net profit. Source A reports 640276 AED, Source B reports 1307124 AED. Difference: 666848.'
        }
    ];

    const result = buildConflictAnswer('What is the net profit?', conflictFacts, []);

    assert.ok(result.includes('⚠️'), 'Should have conflict warning emoji');
    assert.ok(result.includes('Unresolved'), 'Should show conflict status');
    assert.ok(result.includes('06_Contoso_Properties_Management_Pack_Q1_2026.pdf'), 'Should cite source A');
    assert.ok(result.includes('01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf'), 'Should cite source B');
    assert.ok(result.includes('640'), 'Should show value from source A');
    assert.ok(result.includes('1,307,124') || result.includes('1307124'), 'Should show value from source B');
    assert.ok(result.includes('human reviewer') || result.includes('Review Required'), 'Should mention human review');
});

test('buildConflictAnswer returns resolved conflict summary for resolved conflicts', () => {
    const resolvedFacts = [
        {
            Metric: 'Net profit for the period',
            Entity: 'Contoso Retail LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 1307124,
            Currency: 'AED',
            SourceFileName: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf',
            AuthorityRank: 1,
            AuthorityType: 'Audited Financials',
            hasConflict: true,
            conflictStatus: 'Resolved - Higher Authority Adopted',
            conflictExplanation: 'Adopted Audited Financials over Draft. Draft reported 1467739 AED. Discrepancy: 160615 AED.'
        }
    ];

    const result = buildConflictAnswer('What is the net profit?', [], resolvedFacts);

    assert.ok(result.includes('✅'), 'Should have resolved emoji');
    assert.ok(result.includes('Resolved') || result.includes('Adopted'), 'Should indicate resolution');
    assert.ok(result.includes('01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf'), 'Should cite adopted source');
});

test('buildConflictAnswer returns empty string when no conflicts passed', () => {
    const result = buildConflictAnswer('What is the net profit?', [], []);
    assert.equal(result.trim(), '', 'Should return empty string when no conflicts');
});

test('buildConflictAnswer deduplicates same source appearing multiple times (different entity labels)', () => {
    // SQL returns two rows for the same metric from the same source (entity "Category Breakdown"
    // AND entity "Contoso Retail LLC | Audited..." both pointing to the same file & value)
    const duplicatedConflictFacts = [
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 640276,
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement for Net profit. Difference: 666848.'
        },
        {
            Metric: 'Net profit for the period',
            Entity: 'Contoso Properties LLC | Prepared 14 April 2026',   // different entity label
            PeriodLabel: 'Q1 2026',
            NumericValue: 640276,                                          // same value & source
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement for Net profit. Difference: 666848.'
        },
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 1307124,
            Currency: 'AED',
            SourceFileName: '01_Contoso_Retail_Income_Statement_Q1_2026_Audited.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement for Net profit. Difference: 666848.'
        }
    ];

    const result = buildConflictAnswer('What is the net profit?', duplicatedConflictFacts, []);

    // Should contain each source file name only ONCE
    const countA = (result.match(/06_Contoso_Properties_Management_Pack_Q1_2026\.pdf/g) || []).length;
    const countB = (result.match(/01_Contoso_Retail_Income_Statement_Q1_2026_Audited\.pdf/g) || []).length;
    assert.equal(countA, 1, `Source A file should appear exactly once, got ${countA}`);
    assert.equal(countB, 1, `Source B file should appear exactly once, got ${countB}`);

    // Conflict block should appear only once (not twice because of entity label variants)
    const conflictHeaderCount = (result.match(/⚠️/g) || []).length;
    assert.equal(conflictHeaderCount, 1, `Conflict header should appear exactly once, got ${conflictHeaderCount}`);
});

test('buildConflictAnswer deduplicates same explanation across different metric name spellings', () => {
    // "Net profit" and "Net profit for the period" share the same conflictExplanation text —
    // should only emit one conflict block, not two.
    const sameFacts = [
        {
            Metric: 'Net profit',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 640276,
            Currency: 'AED',
            SourceFileName: 'source_A.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement. Difference: 666848.'
        },
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Q1 2026',
            NumericValue: 1307124,
            Currency: 'AED',
            SourceFileName: 'source_B.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement. Difference: 666848.'  // same explanation
        }
    ];

    const result = buildConflictAnswer('What is the net profit?', sameFacts, []);

    // Only one ⚠️ block should appear because the explanation is identical
    const conflictHeaderCount = (result.match(/⚠️/g) || []).length;
    assert.equal(conflictHeaderCount, 1, `Same explanation should produce only 1 conflict block, got ${conflictHeaderCount}`);
});

test('findRelevantStructuredFacts returns only net-profit-matched facts when metric is detected', () => {
    const facts = [
        {
            FactId: 1,
            Metric: 'Net profit for the period',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 640276,
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            hasConflict: false
        },
        {
            FactId: 2,
            Metric: 'Gross profit',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 4617600,
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            hasConflict: false
        },
        {
            FactId: 3,
            Metric: 'Total Revenue',
            Entity: 'Contoso Properties LLC',
            PeriodLabel: 'Q1 2026',
            NumericValue: 8000000,
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            hasConflict: false
        }
    ];

    const question = 'What is the net profit for Contoso Properties LLC for Q1 2026?';
    const intent = classifyIntentByRules(question);

    const relevant = findRelevantStructuredFacts(question, facts, intent);

    // Should return ONLY the net profit fact, not gross profit or revenue
    assert.ok(relevant.length > 0, 'Should return at least one fact');
    assert.ok(relevant.every(f => (f.Metric || '').toLowerCase().includes('net profit') || (f.Metric || '').toLowerCase().includes('profit')));
    assert.ok(!relevant.some(f => (f.Metric || '').toLowerCase().includes('total revenue')));
});

test('appendConflictDetailsToAnswer appends conflict status and conflict explanation when conflicts exist', () => {
    const answer = 'The reported Net profit for Contoso Properties LLC in Q1 2026 is AED 640,276.';
    const facts = [
        {
            Metric: 'Net profit for the period',
            NumericValue: 640276,
            Currency: 'AED',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement: "01_Contoso_Retail..." reports 1307124 while "06_Contoso_Properties..." reports 640276.'
        }
    ];

    const result = appendConflictDetailsToAnswer(answer, facts);
    assert.ok(result.includes('The reported Net profit'));
    assert.ok(result.includes('**Conflict Status:** Unresolved - Review Required'));
    assert.ok(result.includes('**Conflict Explanation:** Equal-rank disagreement'));
});

test('appendConflictDetailsToAnswer appends multiple conflict statuses and explanations when a number of conflicts exist', () => {
    const answer = 'Here are the financial figures for Contoso.';
    const facts = [
        {
            Metric: 'Net profit for the period',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Net profit mismatch of 666,848 AED.'
        },
        {
            Metric: 'Gross profit',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Gross profit mismatch of 425,600 AED.'
        }
    ];

    const result = appendConflictDetailsToAnswer(answer, facts);
    assert.ok(result.includes('**Conflict Status:** Unresolved - Review Required'));
    assert.ok(result.includes('Net profit mismatch of 666,848 AED.'));
    assert.ok(result.includes('Gross profit mismatch of 425,600 AED.'));
});

test('validateRetrievalResponse populates factsUsed with conflict details when route is DIRECT_SQL', () => {
    const retainedFacts = [
        {
            FactId: 2602,
            DocumentId: 303,
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Not specified',
            NumericValue: 640276,
            Unit: 'amount',
            Currency: 'AED',
            SourceLocation: 'Page 1 - Table Row',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement. Difference: -666848.'
        }
    ];

    const validated = validateRetrievalResponse({
        answer: 'Test answer',
        routeUsed: 'DIRECT_SQL',
        retainedFacts,
        retainedChunks: [],
        hasUnresolvedConflict: true,
        insufficientEvidence: false
    });

    assert.ok(Array.isArray(validated.factsUsedOutput));
    assert.equal(validated.factsUsedOutput.length, 1);
    assert.equal(validated.factsUsedOutput[0].metric, 'Net profit for the period');
    assert.equal(validated.factsUsedOutput[0].value, 640276);
    assert.equal(validated.factsUsedOutput[0].currency, 'AED');
    assert.equal(validated.factsUsedOutput[0].hasConflict, true);
    assert.equal(validated.factsUsedOutput[0].conflictStatus, 'Unresolved - Review Required');
    assert.equal(validated.factsUsedOutput[0].conflictExplanation, 'Equal-rank disagreement. Difference: -666848.');
});


test('deduplicateFactsUsed removes duplicate (metric, value, sourceFile) rows and keeps conflict-enriched entry', () => {
    // Simulate SQL returning same fact 3x (different ingestion passes),
    // one of them with conflict data, two without.
    const rawFacts = [
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Not specified',
            NumericValue: 640276,
            Unit: 'amount',
            Currency: 'AED',
            SourceLocation: 'Page 1 - Table Row',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: false,   // first pass — no conflict linked yet
            conflictStatus: null,
            conflictExplanation: null
        },
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Not specified',
            NumericValue: 640276,
            Unit: 'amount',
            Currency: 'AED',
            SourceLocation: 'Page 1 - Table Row',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,    // second pass — has conflict data
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Equal-rank disagreement. Difference: -666848.'
        },
        {
            Metric: 'Net profit for the period',
            Entity: 'Category Breakdown',
            PeriodLabel: 'Not specified',
            NumericValue: 640276,
            Unit: 'amount',
            Currency: 'AED',
            SourceLocation: 'Page 1 - Table Row',
            SourceFileName: '06_Contoso_Properties_Management_Pack_Q1_2026.pdf',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: false,   // third pass — no conflict linked
            conflictStatus: null,
            conflictExplanation: null
        },
        // Different sourceFile — should NOT be deduplicated away
        {
            Metric: 'Net profit',
            Entity: 'Consolidated',
            PeriodLabel: 'Not specified',
            NumericValue: 642,
            Unit: 'amount',
            Currency: 'AED',
            SourceLocation: 'Table 1, Row 12',
            SourceFileName: '10_Contoso_Properties_Budget_FY2026.xlsx',
            AuthorityRank: 4,
            AuthorityType: 'Sample / Test',
            hasConflict: true,
            conflictStatus: 'Unresolved - Review Required',
            conflictExplanation: 'Net profit mismatch AED 642 vs 855400.'
        }
    ];

    const result = deduplicateFactsUsed(rawFacts);

    // 3 identical rows collapse to 1; different sourceFile keeps its own entry = 2 total
    assert.equal(result.length, 2, `Expected 2 unique facts, got ${result.length}`);

    // The surviving entry for the first metric must carry the conflict data
    const netProfitEntry = result.find(r => r.metric === 'Net profit for the period');
    assert.ok(netProfitEntry, 'Net profit for the period fact must exist');
    assert.equal(netProfitEntry.hasConflict, true, 'Should preserve conflict data over non-conflict duplicate');
    assert.equal(netProfitEntry.conflictStatus, 'Unresolved - Review Required');

    // Second metric entry must be intact
    const budgetEntry = result.find(r => r.sourceFile === '10_Contoso_Properties_Budget_FY2026.xlsx');
    assert.ok(budgetEntry, 'Budget fact must remain');
    assert.equal(budgetEntry.value, 642);
});
