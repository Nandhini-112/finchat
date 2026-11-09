/**
 * Authority Normalization Utility
 * Finora Azure AI - Employee Authority Ranking Module (Phase 1)
 * 
 * Provides deterministic, case-insensitive string normalization
 * for Job Title, Department, and Email addresses.
 * 
 * Guarantees:
 * - Trims leading and trailing spaces.
 * - Normalizes repeated internal whitespace.
 * - Applies consistent lowercase case normalization.
 * - Never changes the actual stored display values.
 * - Never applies fuzzy or heuristic guessing.
 */

/**
 * Collapses internal whitespace and trims.
 */
function normalizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Normalizes job title for deterministic database lookup.
 * Trims leading/trailing whitespace, collapses internal whitespace,
 * converts to lowercase, and strips harmless trailing punctuation.
 * 
 * @param {string} jobTitle - Raw job title string
 * @returns {string|null} - Normalized job title or null if empty/invalid
 */
function normalizeJobTitle(jobTitle) {
    if (!jobTitle || typeof jobTitle !== 'string') return null;
    const cleaned = normalizeString(jobTitle)
        .replace(/^[,\.\-_/]+|[,\.\-_/]+$/g, '')
        .trim();
    return cleaned || null;
}

/**
 * Normalizes department name for deterministic database lookup.
 * Trims leading/trailing whitespace, collapses internal whitespace,
 * converts to lowercase, and strips harmless trailing punctuation.
 * 
 * @param {string} department - Raw department string
 * @returns {string|null} - Normalized department or null if empty/invalid
 */
function normalizeDepartment(department) {
    if (!department || typeof department !== 'string') return null;
    const cleaned = normalizeString(department)
        .replace(/^[,\.\-_/]+|[,\.\-_/]+$/g, '')
        .trim();
    return cleaned || null;
}

/**
 * Normalizes email address for case-insensitive unique lookup and storage.
 * Trims whitespace and converts to lowercase.
 * 
 * @param {string} email - Raw email string
 * @returns {string|null} - Normalized email or null if empty/invalid
 */
function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const cleaned = normalizeString(email);
    return cleaned || null;
}

module.exports = {
    normalizeJobTitle,
    normalizeDepartment,
    normalizeEmail
};

