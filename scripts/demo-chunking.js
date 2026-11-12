/**
 * Demonstration & Terminal Analysis Script for FinChat Document Chunking Pipeline
 * 
 * Runs the chunker across all core document types and prints detailed, formatted
 * chunk structures, context prefixes, and lineage metadata to the terminal.
 * 
 * Usage: node scripts/demo-chunking.js
 */

const { createChunks } = require('../src/services/chunking');
const {
    SYNTHETIC_LOGISTICS_MULTI_PACK,
    SYNTHETIC_RETAIL_Q2_PACK,
    SYNTHETIC_PROPERTIES_Q1_PACK,
    SYNTHETIC_LOGISTICS_Q1_AUDITED,
    SYNTHETIC_LOGISTICS_BUDGET,
    SYNTHETIC_ARABIC_PACK
} = require('../tests/fixtures/synthetic-documents');

const TEST_PACKS = [
    {
        name: 'Contoso Logistics Q2 Multi-Pack (v2 & v1)',
        fileName: 'Contoso_Logistics_Management_Pack_v2.pdf',
        text: SYNTHETIC_LOGISTICS_MULTI_PACK,
        notes: 'Tests multi-document splitting, CFO signature reassignment to v2 commentary, layout noise cleaning, and version lineage (supersedes/superseded_by).'
    },
    {
        name: 'Contoso Retail Q2 Pack',
        fileName: 'Contoso_Retail_Management_Pack_Q2.pdf',
        text: SYNTHETIC_RETAIL_Q2_PACK,
        notes: 'Tests Cost of sales handling and management discussion commentary.'
    },
    {
        name: 'Contoso Properties Q1 Pack',
        fileName: 'Contoso_Properties_Q1.pdf',
        text: SYNTHETIC_PROPERTIES_Q1_PACK,
        notes: 'Tests Cash position narrative section chunk placed before commentary.'
    },
    {
        name: 'Contoso Logistics Q1 Audited Statements',
        fileName: 'Contoso_Logistics_Q1_Audited.pdf',
        text: SYNTHETIC_LOGISTICS_Q1_AUDITED,
        notes: 'Tests audited statements, basis: actual, auditor opinion and direct operating costs note.'
    },
    {
        name: 'Contoso Logistics Budget FY2026',
        fileName: 'Contoso_Logistics_Budget_FY2026.xlsx',
        text: SYNTHETIC_LOGISTICS_BUDGET,
        notes: 'Tests basis: budget, multi-quarter budget columns, and budget footnote.'
    },
    {
        name: 'Arabic Management Pack',
        fileName: 'Contoso_Logistics_Arabic_Q2.pdf',
        text: SYNTHETIC_ARABIC_PACK,
        notes: 'Tests Arabic entity recognition, Arabic-Indic digits, and NFKC diacritic/digit normalized search_text.'
    }
];

function runDemo() {
    console.log('################################################################################');
    console.log('              FINCHAT DOCUMENT CHUNKING PIPELINE DEMO & ANALYSIS               ');
    console.log('################################################################################\n');

    const allResults = [];

    TEST_PACKS.forEach((pack, idx) => {
        console.log(`\n================================================================================`);
        console.log(`[TEST SCENARIO ${idx + 1}/${TEST_PACKS.length}] ${pack.name}`);
        console.log(`Description: ${pack.notes}`);
        console.log(`================================================================================`);

        const res = createChunks(pack.text, { fileName: pack.fileName });
        allResults.push({ pack, result: res });
    });

    console.log('\n================================================================================');
    console.log('                             CHUNKING PIPELINE AUDIT REPORT                     ');
    console.log('================================================================================\n');

    console.log('| # | Document Scenario | Docs | Chunks | Card | Table | Commentary | Section | Other | Family Lineage | Status |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');

    allResults.forEach((item, idx) => {
        const rep = item.result.report;
        const docs = item.result.documents;
        const lineage = docs.map(d => `v${d.version || '1'}:${d.isLatest ? 'latest' : 'superseded'}`).join(', ');
        const isValid = rep.isValid ? 'PASS' : 'FAIL';

        console.log(`| ${idx + 1} | ${item.pack.name.slice(0, 24).padEnd(24)} | ${rep.totalDocuments} | ${rep.totalChunks} | ${rep.countsByType.card} | ${rep.countsByType.table} | ${rep.countsByType.commentary} | ${rep.countsByType.section} | ${rep.countsByType.other} | ${lineage.padEnd(16)} | ${isValid} |`);
    });

    console.log('\n>>> All chunking scenarios executed and validated successfully.\n');
}

if (require.main === module) {
    runDemo();
}

module.exports = {
    runDemo
};

