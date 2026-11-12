const { CHARS_PER_TOKEN, LANGUAGE_THRESHOLDS } = require('../../config/chunking');

/**
 * Builds the canonical 1-line context prefix header for a chunk.
 * Format: [Entity | Document title short vN | Period | Currency | Status | Audited/Unaudited | Chunk type | Section]
 * Omits unknown parts cleanly without guessing.
 */
function buildContextPrefix(doc, chunkType, sectionTitle = null) {
    const parts = [];

    // 1. Entity
    if (doc.entity) {
        parts.push(doc.entity);
    }

    // 2. Short title with version and status
    const titleParts = [];
    if (doc.title) {
        // Shorten long title if needed
        const shortTitle = doc.title.replace(/\s*–\s*Statement\s+of[^\n]*/i, '').trim();
        titleParts.push(shortTitle);
    } else if (doc.documentType) {
        titleParts.push(doc.documentType);
    }

    if (doc.version !== null && doc.version !== undefined) {
        titleParts.push(`v${doc.version}`);
    }

    if (doc.status) {
        const statusLabel = doc.status.charAt(0).toUpperCase() + doc.status.slice(1);
        titleParts.push(`– ${statusLabel}`);
    }

    if (doc.audited === false) {
        titleParts.push('(unaudited)');
    } else if (doc.audited === true) {
        titleParts.push('(audited)');
    }

    if (titleParts.length > 0) {
        parts.push(titleParts.join(' ').replace(/\s+–\s+–/g, ' –'));
    }

    // 3. Period
    if (doc.periodLabel) {
        parts.push(doc.periodLabel);
    }

    // 4. Currency
    if (doc.currency) {
        parts.push(doc.currency);
    }

    // 5. Chunk Type Label
    const typeLabels = {
        card: 'Summary Card',
        table: 'Table',
        commentary: 'Commentary',
        section: 'Section',
        other: 'Other'
    };
    parts.push(typeLabels[chunkType] || chunkType);

    // 6. Section Title (if distinct from chunk type)
    if (sectionTitle && chunkType === 'section') {
        parts.push(sectionTitle);
    }

    // 7. Basis (if present)
    if (doc.basis) {
        parts.push(`basis: ${doc.basis}`);
    }

    return `[${parts.join(' | ')}]`;
}

/**
 * Classifies text language:
 * 'ar' if Arabic letters > 60%, 'en' if < 10%, else 'mixed'
 */
function classifyLanguage(text) {
    if (!text) return 'en';

    const arabicLetters = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || [];
    const latinLetters = text.match(/[A-Za-z]/g) || [];

    const totalLetters = arabicLetters.length + latinLetters.length;
    if (totalLetters === 0) return 'en';

    const arRatio = arabicLetters.length / totalLetters;
    if (arRatio > LANGUAGE_THRESHOLDS.arabicMinRatio) return 'ar';
    if (arRatio < LANGUAGE_THRESHOLDS.englishMaxArabicRatio) return 'en';
    return 'mixed';
}

/**
 * Estimates token count based on language-specific character ratios:
 * en = 4 chars/token, ar = 2.5 chars/token, mixed = 3 chars/token
 */
function estimateTokens(text, language = 'en') {
    if (!text) return 0;
    const charsPerToken = CHARS_PER_TOKEN[language] || CHARS_PER_TOKEN.en;
    return Math.ceil(text.length / charsPerToken);
}

/**
 * Normalizes Arabic text for Azure AI Search search_text:
 * - NFKC normalization
 * - Strip tatweel (U+0640)
 * - Strip diacritics / harakat (U+064B–U+065F, U+0670)
 * - Unify alef forms (أ, إ, آ => ا)
 * - Convert Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII (0-9)
 */
function normalizeArabicSearchText(text) {
    if (!text) return '';

    // 1. Unicode NFKC
    let normalized = text.normalize('NFKC');

    // 2. Strip Tatweel (U+0640)
    normalized = normalized.replace(/\u0640/g, '');

    // 3. Strip Arabic diacritics (harakat & superscript alef)
    normalized = normalized.replace(/[\u064B-\u065F\u0670]/g, '');

    // 4. Unify Alef forms (أ, إ, آ, ٱ => ا)
    normalized = normalized.replace(/[أإآٱ]/g, 'ا');

    // 5. Convert Arabic-Indic digits (٠-٩) to ASCII
    normalized = normalized.replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660));

    // 6. Convert Eastern Arabic-Indic digits (۰-۹) to ASCII
    normalized = normalized.replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0));

    return normalized;
}

/**
 * Computes search_text for a chunk:
 * - null for 'en'
 * - normalized copy for 'ar' and 'mixed'
 */
function computeSearchText(content, language) {
    if (language === 'en') return null;
    return normalizeArabicSearchText(content);
}

/**
 * Splits text into sentences safely:
 * - After . ! ? ؟ ۔ followed by whitespace or end of string
 * - NEVER inside numbers like 1,250.50 or ١٬٢٥٠٫٥٠
 * - Uses ؛ and ، as soft boundaries if needed
 */
function splitIntoSentences(text) {
    if (!text) return [];

    // Negative lookbehind and lookahead to avoid splitting decimals or abbreviations
    // A sentence ends at [.!?؟۔] followed by whitespace or newline, where it is not surrounded by digits
    const regex = /(?<=[.!?؟۔])\s+(?=[^\d]|$)/g;
    const rawSentences = text.split(regex).map(s => s.trim()).filter(Boolean);

    if (rawSentences.length <= 1) {
        // Check if there are soft Arabic boundaries (؛) if very long
        if (text.length > 500 && text.includes('؛')) {
            return text.split(/(?<=؛)\s+/).map(s => s.trim()).filter(Boolean);
        }
    }

    return rawSentences;
}

module.exports = {
    buildContextPrefix,
    classifyLanguage,
    estimateTokens,
    normalizeArabicSearchText,
    computeSearchText,
    splitIntoSentences
};

