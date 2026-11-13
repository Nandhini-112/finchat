/**
 * Query Preprocessor for Finora Retrieval Pipeline
 *
 * Implements Stage 1 (Query Input) and Stage 2 (Query Preprocessing):
 * - Input validation and original text preservation.
 * - Arabic and English language detection.
 * - Arabic-Indic to Western ASCII numeral normalization (e.g. ٢٠٢٦ -> 2026).
 * - Safe sanitization of control characters.
 * - Conversational follow-up reference resolution using conversation history.
 */

const { extractEntitiesFromQuestion } = require('./intent-classifier');

/**
 * Stage 1: Validate and preserve query input.
 *
 * @param {string} rawQuestion - Raw input question
 * @returns {Object} { originalQuestion, timestamp }
 */
function validateAndPreserveInput(rawQuestion) {
    const originalQuestion = (rawQuestion || '').trim();
    if (!originalQuestion) {
        throw new Error('Field "question" is required and cannot be empty.');
    }
    return {
        originalQuestion,
        timestamp: new Date().toISOString()
    };
}

/**
 * Detect language of query: Arabic ('ar') vs English ('en').
 * Checks for characters in the Arabic Unicode blocks.
 *
 * @param {string} text - Text to analyze
 * @returns {'ar'|'en'} Detected language
 */
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return 'en';
    const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    return arabicRegex.test(text) ? 'ar' : 'en';
}

/**
 * Convert Arabic-Indic numerals (٠-٩) to ASCII digits (0-9)
 * for consistent financial arithmetic and date parsing.
 *
 * @param {string} text
 * @returns {string} Text with normalized numerals
 */
function normalizeArabicNumerals(text) {
    if (!text || typeof text !== 'string') return '';
    const arabicIndicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return text.replace(/[٠-٩]/g, d => arabicIndicDigits.indexOf(d).toString());
}

/**
 * Clean control characters while preserving valid newlines, tabs, and unicode.
 *
 * @param {string} text
 * @returns {string} Sanitized text
 */
function cleanQuestionText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
}

/**
 * Resolve anaphoric follow-up references using previous conversation history.
 * If the current question lacks an entity but has follow-up phrasing,
 * carries over the entity from previous turns.
 *
 * @param {string} question - Current question text
 * @param {Array} conversationHistory - Prior turns: [{ role, content }]
 * @returns {string} Contextualized question
 */
function resolveConversationalReferences(question, conversationHistory = []) {
    if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
        return question;
    }

    const hasEntity = extractEntitiesFromQuestion(question).length > 0;
    const isFollowUp = /(what about|how about|and for|compare with|what was its|show its|what of|ماذا عن|قارن مع)/i.test(question);

    if (!hasEntity && isFollowUp) {
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
            const turn = conversationHistory[i];
            const text = turn.content || turn.question || '';
            const prevEntities = extractEntitiesFromQuestion(text);
            if (prevEntities.length > 0) {
                return `${question} (${prevEntities[0]})`;
            }
        }
    }

    return question;
}

/**
 * Stage 2: Full query preprocessing pipeline.
 *
 * @param {string} rawQuestion - Raw input question
 * @param {Array} [conversationHistory] - Previous chat turns
 * @returns {Object} { originalQuestion, preprocessedQuestion, language, timestamp }
 */
function preprocessQuery(rawQuestion, conversationHistory = []) {
    const inputStage = validateAndPreserveInput(rawQuestion);
    const cleaned = cleanQuestionText(inputStage.originalQuestion);
    const language = detectLanguage(cleaned);
    const normalizedText = normalizeArabicNumerals(cleaned);
    const preprocessedQuestion = resolveConversationalReferences(normalizedText, conversationHistory);

    return {
        originalQuestion: inputStage.originalQuestion,
        preprocessedQuestion,
        language,
        timestamp: inputStage.timestamp
    };
}

module.exports = {
    validateAndPreserveInput,
    detectLanguage,
    normalizeArabicNumerals,
    cleanQuestionText,
    resolveConversationalReferences,
    preprocessQuery
};

