/**
 * Retrieval Evaluation Harness for FinChat Documents
 * 
 * Verifies that the produced chunks contain the necessary information, metadata,
 * and filter criteria to answer the 10 key benchmark questions.
 * 
 * Can run offline against synthetic chunks or against a live Azure AI Search index.
 */

const { createChunks } = require('../src/services/chunking');
const { buildDefaultSearchFilter } = require('../src/services/chunking/search-helpers');
const {
    SYNTHETIC_LOGISTICS_MULTI_PACK,
    SYNTHETIC_RETAIL_Q2_PACK,
    SYNTHETIC_PROPERTIES_Q1_PACK,
    SYNTHETIC_LOGISTICS_Q1_AUDITED,
    SYNTHETIC_LOGISTICS_BUDGET,
    SYNTHETIC_ARABIC_PACK
} = require('../tests/fixtures/synthetic-documents');

const EVAL_BENCHMARK_QUERIES = [
    {
        id: 1,
        question: 'What was Contoso Logistics Q2 revenue?',
        arabicQuestion: 'ما هي إيرادات شركة كونتوسو للخدمات اللوجستية في الربع الثاني؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q2 2026',
        expectedVersion: 2,
        expectedChunkTypes: ['table', 'card'],
        expectedKeywords: ['9,350,000', 'Revenue'],
        requiresHistory: false
    },
    {
        id: 2,
        question: 'What was Contoso Logistics Q1 net profit?',
        arabicQuestion: 'ما هو صافي ربح شركة كونتوسو للخدمات اللوجستية في الربع الأول؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q1 2026',
        expectedVersion: 1,
        expectedChunkTypes: ['table'],
        expectedKeywords: ['980,000', 'Net profit'],
        requiresHistory: false
    },
    {
        id: 3,
        question: 'What is Contoso Properties cash shortfall?',
        arabicQuestion: 'ما هو عجز السيولة النقدية لشركة كونتوسو العقارية؟',
        expectedEntity: 'Contoso Properties LLC',
        expectedPeriod: 'Q1 2026',
        expectedVersion: 1,
        expectedChunkTypes: ['section'],
        expectedKeywords: ['320,000', 'shortfall', '1.18 million'],
        requiresHistory: false
    },
    {
        id: 4,
        question: 'Why did Q2 revenue increase by AED 245,000?',
        arabicQuestion: 'لماذا ارتفعت إيرادات الربع الثاني بمقدار ٢٤٥٬٠٠٠ درهم؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q2 2026',
        expectedVersion: 2,
        expectedChunkTypes: ['table', 'commentary'],
        expectedKeywords: ['245,000', 'final invoicing'],
        requiresHistory: false
    },
    {
        id: 5,
        question: 'Compare Q1 vs Q2 Logistics revenue',
        arabicQuestion: 'مقارنة إيرادات كونتوسو للخدمات اللوجستية بين الربع الأول والربع الثاني',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: null, // multi-period comparison
        expectedVersion: null,
        expectedChunkTypes: ['table'],
        expectedKeywords: ['8,920,000', '9,350,000'],
        isMultiEvidence: true,
        requiresHistory: false
    },
    {
        id: 6,
        question: 'Which report is audited?',
        arabicQuestion: 'أي تقرير يعتبر مدققاً؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q1 2026',
        expectedVersion: 1,
        expectedChunkTypes: ['card', 'section'],
        expectedKeywords: ['audited'],
        requiresHistory: false
    },
    {
        id: 7,
        question: 'What changed between Q2 v1 and v2 for Contoso Logistics?',
        arabicQuestion: 'ما هي التغييرات بين الإصدار الأول والثاني للربع الثاني؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q2 2026',
        expectedVersion: null, // needs both v1 and v2
        expectedChunkTypes: ['card', 'table'],
        expectedKeywords: ['supersedes', '245,000'],
        requiresHistory: true // history mode enabled
    },
    {
        id: 8,
        question: 'Which costs are in direct operating costs for Contoso Logistics?',
        arabicQuestion: 'ما هي التكاليف المدرجة في تكاليف التشغيل المباشرة؟',
        expectedEntity: 'Contoso Logistics LLC',
        expectedPeriod: 'Q1 2026',
        expectedVersion: 1,
        expectedChunkTypes: ['table', 'section'],
        expectedKeywords: ['fuel', 'driver compensation', 'leases', 'haulage'],
        requiresHistory: false
    },
    {
        id: 9,
        question: 'What is the cash position vs minimum requirement for Contoso Properties?',
        arabicQuestion: 'ما هو الموقف المالي مقارنة بالحد الأدنى المطلوب؟',
        expectedEntity: 'Contoso Properties LLC',
        expectedPeriod: 'Q1 2026',
        expectedVersion: 1,
        expectedChunkTypes: ['section'],
        expectedKeywords: ['1.18 million', '1.5 million', '320,000'],
        requiresHistory: false
    },
    {
        id: 10,
        question: 'ما هي أحجام النقل على مسار جبل علي إلى أبوظبي؟',
        arabicQuestion: 'ما هي أحجام النقل على مسار جبل علي إلى أبوظبي؟',
        expectedEntity: 'كونتوسو للخدمات اللوجستية',
        expectedPeriod: '٣٠ يونيو ٢٠٢٦',
        expectedVersion: 2,
        expectedChunkTypes: ['commentary'],
        expectedKeywords: ['٩٪', 'جبل علي'],
        requiresHistory: false
    }
];

function runEvaluation() {
    console.log('================================================================');
    console.log('FINCHAT RETRIEVAL EVALUATION HARNESS');
    console.log('================================================================\n');

    // 1. Ingest all synthetic documents
    const allSyntheticInputs = [
        { text: SYNTHETIC_LOGISTICS_MULTI_PACK, fileName: 'Contoso_Logistics_Management_Pack_v2.pdf' },
        { text: SYNTHETIC_RETAIL_Q2_PACK, fileName: 'Contoso_Retail_Management_Pack_Q2.pdf' },
        { text: SYNTHETIC_PROPERTIES_Q1_PACK, fileName: 'Contoso_Properties_Q1.pdf' },
        { text: SYNTHETIC_LOGISTICS_Q1_AUDITED, fileName: 'Contoso_Logistics_Q1_Audited.pdf' },
        { text: SYNTHETIC_LOGISTICS_BUDGET, fileName: 'Contoso_Logistics_Budget_FY2026.xlsx' },
        { text: SYNTHETIC_ARABIC_PACK, fileName: 'Contoso_Logistics_Arabic_Q2.pdf' }
    ];

    const indexedChunks = [];
    for (const doc of allSyntheticInputs) {
        const res = createChunks(doc.text, { fileName: doc.fileName });
        indexedChunks.push(...res.chunks);
    }

    console.log(`Generated ${indexedChunks.length} total chunks from ${allSyntheticInputs.length} fixture documents.\n`);

    let passedCount = 0;

    EVAL_BENCHMARK_QUERIES.forEach(query => {
        const filterStr = buildDefaultSearchFilter({
            entity: query.expectedEntity,
            period: query.expectedPeriod,
            includeHistory: query.requiresHistory
        });

        // Filter candidate chunks
        const candidates = indexedChunks.filter(c => {
            const meta = c.metadata;

            // Entity match
            if (query.expectedEntity) {
                if (!meta.entity) return false;
                const matchEn = meta.entity.toLowerCase().includes(query.expectedEntity.toLowerCase());
                const matchAr = meta.entity.includes(query.expectedEntity) || query.expectedEntity.includes(meta.entity);
                if (!matchEn && !matchAr) return false;
            }

            // Period match
            if (query.expectedPeriod) {
                if (!meta.period_label || !meta.period_label.includes(query.expectedPeriod)) {
                    return false;
                }
            }

            // Version match
            if (query.expectedVersion !== null && meta.version !== query.expectedVersion) {
                return false;
            }

            // History mode check: if requiresHistory is false, exclude superseded
            if (!query.requiresHistory && meta.is_latest === false) {
                return false;
            }

            // Chunk type match
            if (query.expectedChunkTypes && !query.expectedChunkTypes.includes(c.chunk_type)) {
                return false;
            }

            return true;
        });

        // Keyword verification
        const matchingChunks = candidates.filter(c => {
            const textToSearch = `${c.content}\n${c.search_text || ''}`.toLowerCase();
            if (query.isMultiEvidence) {
                return (query.expectedKeywords || []).some(kw => textToSearch.includes(kw.toLowerCase()));
            } else {
                return (query.expectedKeywords || []).every(kw => textToSearch.includes(kw.toLowerCase()));
            }
        });

        // For multi-evidence queries, verify that all required periods are covered
        let success = false;
        if (query.isMultiEvidence) {
            const coveredKeywords = new Set();
            matchingChunks.forEach(c => {
                const text = c.content.toLowerCase();
                (query.expectedKeywords || []).forEach(kw => {
                    if (text.includes(kw.toLowerCase())) coveredKeywords.add(kw);
                });
            });
            success = coveredKeywords.size === query.expectedKeywords.length;
        } else {
            success = matchingChunks.length > 0;
        }

        if (success) passedCount++;

        console.log(`Query ${query.id}: "${query.question}"`);
        console.log(`  Filter Generated : ${filterStr}`);
        console.log(`  Candidate Chunks : ${candidates.length}`);
        console.log(`  Matching Evidence: ${matchingChunks.length} chunk(s) found`);
        if (success) {
            console.log(`  Result           : PASS (Evidence ID(s): ${matchingChunks.map(c => c.id).slice(0, 2).join(', ')})`);
        } else {
            console.log(`  Result           : FAIL (No matching candidate satisfied keywords)`);
        }
        console.log('');
    });

    console.log('----------------------------------------------------------------');
    console.log(`EVALUATION SUMMARY: ${passedCount} / ${EVAL_BENCHMARK_QUERIES.length} queries successfully matched target evidence.`);
    console.log('----------------------------------------------------------------');

    if (passedCount < EVAL_BENCHMARK_QUERIES.length) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runEvaluation();
}

module.exports = {
    EVAL_BENCHMARK_QUERIES,
    runEvaluation
};
