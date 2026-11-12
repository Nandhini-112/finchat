/**
 * FinChat Document Chunking Configuration
 * 
 * Central configuration module defining token thresholds, element sizes,
 * Arabic/English regex patterns, heading synonyms, and validation constants.
 * Pure Node.js CommonJS - zero external dependencies, zero YAML.
 */

const TOKEN_LIMITS = {
    // Sizing targets in tokens (estimated via character count / charsPerToken)
    targetCommentary: 400,
    minCommentary: 50,
    targetSection: 400,
    minSection: 50,
    tableMaxTokens: 1000,
    hardCapTokens: 1500,

    // Overlap for sentence-split narrative sections (~12%)
    narrativeOverlapRatio: 0.12
};

const CHARS_PER_TOKEN = {
    en: 4.0,
    ar: 2.5,
    mixed: 3.0
};

const NOTE_LIMITS = {
    maxSingleNoteChars: 600,
    maxTotalAttachedNoteChars: 1200
};

const LANGUAGE_THRESHOLDS = {
    // Letter ratios (ignoring digits, whitespace, and punctuation)
    arabicMinRatio: 0.60, // > 60% Arabic letters => 'ar'
    englishMaxArabicRatio: 0.10 // < 10% Arabic letters => 'en'
    // Between 10% and 60% => 'mixed'
};

const HEADING_SYNONYMS = {
    commentary: [
        /cfo\s+commentary/i,
        /chief\s+financial\s+officer(?:\s+commentary|\s+report)?/i,
        /management\s+commentary/i,
        /management\s+discussion(?:\s+and\s+analysis)?/i,
        /operational\s+commentary/i,
        /review\s+of\s+operations/i,
        /executive\s+commentary/i,
        /leadership\s+commentary/i,
        /managing\s+director(?:\s+commentary|\s+report)?/i,
        // Arabic
        /تعليق\s+المدير\s+المالي/u,
        /تقرير\s+المدير\s+المالي/u,
        /تقرير\s+الإدارة/u,
        /تقرير\s+الأداء\s+التشغيلي/u,
        /مناقشة\s+الإدارة\s+وتحليلها/u,
        /بيان\s+الإدارة/u
    ],

    sections: {
        cashPosition: [
            /cash\s+position/i,
            /liquidity\s+review/i,
            /cash\s+flow\s+summary/i,
            /treasury\s+update/i,
            /السيولة\s+النقدية/u,
            /الموقف\s+المالي/u,
            /حركة\s+النقدية/u
        ],
        directOperatingCosts: [
            /direct\s+operating\s+costs/i,
            /cost\s+of\s+sales/i,
            /cost\s+of\s+goods\s+sold/i,
            /cost\s+of\s+revenue/i,
            /تكاليف\s+التشغيل\s+المباشرة/u,
            /تكلفة\s+المبيعات/u,
            /تكلفة\s+الإيرادات/u
        ],
        auditorReport: [
            /auditor(?:'s)?\s+report/i,
            /independent\s+auditor(?:'s)?\s+report/i,
            /audit\s+opinion/i,
            /تقرير\s+مراجع\s+الحسابات/u,
            /تقرير\s+مراقب\s+الحسابات/u
        ],
        riskDisclosures: [
            /risk\s+disclosures/i,
            /financial\s+risk\s+management/i,
            /market\s+risk/i,
            /credit\s+risk/i,
            /إفصاحات\s+المخاطر/u,
            /إدارة\s+المخاطر/u
        ],
        accountingPolicies: [
            /accounting\s+policies/i,
            /basis\s+of\s+preparation/i,
            /summary\s+of\s+significant\s+accounting\s+policies/i,
            /السياسات\s+المحاسبية/u,
            /أسس\s+إعداد\s+القوائم\s+المالية/u
        ]
    }
};

const METADATA_PATTERNS = {
    // Entities: detect legal structures and common Arabic/English company naming conventions
    entity: [
        /\b([A-Z][A-Za-z0-9&.,' -]+?\s+(?:LLC|L\.L\.C\.|Corp|Corp\.|Inc|Inc\.|Ltd|Ltd\.|Limited|Company|Co\.|Holdings|Group|PLC))\b/,
        /(?:شركة|مؤسسة)\s+([\u0621-\u064A0-9\s]+?(?:ذ\.م\.م|ش\.م\.ع|ش\.م\.م|المحدودة|القابضة|المساهمة))/u,
        /\b(Contoso\s+[A-Za-z0-9& -]+?(?:LLC|Ltd|Corp)?)\b/i
    ],

    // Document types
    documentType: [
        { type: 'Management Pack', pattern: /management\s+pack/i },
        { type: 'Financial Statements', pattern: /(?:financial\s+statements|statement\s+of\s+profit\s+or\s+loss|balance\s+sheet)/i },
        { type: 'Budget', pattern: /budget(?:\s+workbook|\s+fy\d{4})?/i },
        { type: 'Audited Financial Statements', pattern: /audited\s+(?:financial\s+statements|accounts|report)/i },
        { type: 'Management Pack', pattern: /تقرير\s+الإدارة\s+المالي/u },
        { type: 'Financial Statements', pattern: /القوائم\s+المالية/u },
        { type: 'Budget', pattern: /الميزانية\s+التقديرية/u }
    ],

    // Periods (Quarter, Year, Range)
    period: [
        /\b(Q[1-4]\s*(?:20\d\d|\d\d))\b/i,
        /\b(FY\s*(?:20\d\d|\d\d))\b/i,
        /quarter\s+ended\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
        /quarter\s+ended\s+(\d{4}-\d{2}-\d{2})/i,
        /period\s+ended\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
        /for\s+the\s+year\s+ended\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
        /للربع\s+المنتهي\s+في\s+([\d\u0660-\u0669]+\s+[\u0621-\u064A]+\s+[\d\u0660-\u0669]+)/u,
        /للربع\s+المنتهي\s+في\s+(\d{4}-\d{2}-\d{2})/u,
        /(الربع\s+(?:الأول|الثاني|الثالث|الرابع|[1-4\u0661-\u0664])\s*[\d\u0660-\u0669]{2,4})/u,
        /السنة\s+المالية\s+([\d\u0660-\u0669]{2,4})/u
    ],

    // Currencies
    currency: [
        { code: 'AED', pattern: /\b(?:currency:\s*)?AED\b|\bدرهم\b|\bد\.إ\b/i },
        { code: 'USD', pattern: /\b(?:currency:\s*)?USD\b|\$|\bدولار\b/i },
        { code: 'SAR', pattern: /\b(?:currency:\s*)?SAR\b|\bريال(?:\s+سعودي)?\b|\bر\.س\b/i },
        { code: 'EUR', pattern: /\b(?:currency:\s*)?EUR\b|€|\bيورو\b/i },
        { code: 'GBP', pattern: /\b(?:currency:\s*)?GBP\b|£|\bجنيه\s+إسترليني\b/i },
        { code: 'KWD', pattern: /\b(?:currency:\s*)?KWD\b|\bدينار(?:\s+كويتي)?\b|\bد\.ك\b/i },
        { code: 'INR', pattern: /\b(?:currency:\s*)?INR\b|₹|\bروبية\b/i }
    ],

    // Status: draft, final, approved
    status: [
        { status: 'draft', pattern: /\b(?:status:\s*)?(?:draft|superseded|not\s+approved)\b/i },
        { status: 'final', pattern: /\b(?:status:\s*)?final\b/i },
        { status: 'approved', pattern: /\b(?:status:\s*)?approved\b/i },
        { status: 'draft', pattern: /مسودة/u },
        { status: 'final', pattern: /نهائي/u },
        { status: 'approved', pattern: /معتمد/u }
    ],

    // Audited: IMPORTANT - Check 'unaudited' / 'غير مدقق' FIRST before 'audited' / 'مدقق'
    auditOrder: [
        { audited: false, pattern: /\b(?:un[- ]?audited|not\s+audited)\b/i },
        { audited: false, pattern: /غير\s+مدقق(?:ة)?/u },
        { audited: true, pattern: /\baudited\b/i },
        { audited: true, pattern: /مدقق(?:ة)?/u }
    ],

    // Version: Must be word-bounded (\bv(?:ersion)?\s*(\d+)), not a loose 'v'
    version: [
        /\bv(?:ersion)?\s*(\d+)\b/i,
        /نسخة\s*([\d\u0660-\u0669]+)/u,
        /الإصدار\s*([\d\u0660-\u0669]+)/u,
        /\bver\.\s*(\d+)\b/i
    ],

    // Basis: actual, budget, draft, forecast
    basis: [
        { basis: 'budget', pattern: /\b(?:basis:\s*)?budget(?:ed)?\b/i },
        { basis: 'forecast', pattern: /\b(?:basis:\s*)?forecast\b/i },
        { basis: 'draft', pattern: /\b(?:basis:\s*)?draft\b/i },
        { basis: 'actual', pattern: /\b(?:basis:\s*)?actual\b/i },
        { basis: 'budget', pattern: /ميزانية\s+تقديرية/u },
        { basis: 'actual', pattern: /فعلي/u }
    ],

    // Supersedes text
    supersedesText: [
        /supersedes\s+([^\n\r.]+)/i,
        /superseded\s+by\s+([^\n\r.]+)/i,
        /يلغي\s+ويحل\s+محل\s+([^\n\r.]+)/u
    ],

    // Dates: prepared_date, approved_date
    preparedDate: [
        /prepared(?:\s+date)?:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i,
        /تاريخ\s+الإعداد:\s*(\d{1,2}\s+[\u0621-\u064A]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/u
    ],

    approvedDate: [
        /approved(?:\s+date)?:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i,
        /تاريخ\s+الاعتماد:\s*(\d{1,2}\s+[\u0621-\u064A]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/u
    ],

    // Signatures
    signature: [
        /^–\s*(?:Chief\s+Financial\s+Officer|CFO|Managing\s+Director|Finance\s+Director|Finance\s+Manager|Controller|Partner|Auditor|المدير\s+المالي)[\s\S]*$/i,
        /^[-–—]\s*([A-Za-z\u0621-\u064A\s,.'()]+(?:Officer|Director|Manager|Partner|Auditor|LLC|Ltd|المدير|المحاسب)[\s\S]*)$/m
    ],

    // Watermark
    watermarkDraft: /^(?:DRAFT|\bمسودة\b)$/i
};

module.exports = {
    TOKEN_LIMITS,
    CHARS_PER_TOKEN,
    NOTE_LIMITS,
    LANGUAGE_THRESHOLDS,
    HEADING_SYNONYMS,
    METADATA_PATTERNS
};
