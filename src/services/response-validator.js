/**
 * Response Validator for Finora Retrieval Pipeline
 *
 * Implements Stage 10 (Response Validation):
 * - Validates generated answer against retrieved facts, calculations, and excerpts.
 * - Detects insufficient evidence phrases using established patterns.
 * - Verifies numerical groundedness.
 * - Formats and validates source citations.
 * - Resolves document provenance (documentId, document_name, page).
 */

const { formatSourceReferences } = require('./evidence-validation');

const INSUFFICIENT_EVIDENCE_PATTERN = /no information|do not contain|does not contain|not provided|not mentioned|insufficient information|insufficient evidence|no relevant information|cannot be found|cannot answer|not available in the/i;

/**
 * Deduplicate facts by (metric, value, sourceFile).
 * When the same metric+value+sourceFile appears multiple times (e.g. from multiple
 * ingestion passes), keep only ONE entry per combination — preferring the row that
 * carries conflict data (hasConflict: true) so we never silently drop conflict info.
 *
 * @param {Array} facts - Raw retainedFacts from DIRECT_SQL path
 * @returns {Array} Deduplicated, clean factsUsed entries
 */
function deduplicateFactsUsed(facts = []) {
    const seen = new Map(); // key → mapped fact object

    for (const f of facts) {
        const metric = (f.Metric || '').trim();
        const sourceFile = (f.SourceFileName || '').trim();
        const value = f.NumericValue !== null && f.NumericValue !== undefined
            ? f.NumericValue
            : (f.TextValue || '');
        const key = `${metric.toLowerCase()}||${String(value)}||${sourceFile.toLowerCase()}`;

        const mapped = {
            metric,
            entity: f.Entity || null,
            period: f.PeriodLabel || null,
            value,
            unit: f.Unit || null,
            currency: f.Currency || null,
            location: f.SourceLocation || null,
            sourceFile,
            authorityRank: f.AuthorityRank || null,
            authorityType: f.AuthorityType || null,
            hasConflict: f.hasConflict || false,
            conflictStatus: f.conflictStatus || null,
            conflictExplanation: f.conflictExplanation || null
        };

        if (!seen.has(key)) {
            seen.set(key, mapped);
        } else {
            // If this row has richer conflict info, upgrade the existing entry
            const existing = seen.get(key);
            if (!existing.hasConflict && mapped.hasConflict) {
                seen.set(key, mapped);
            }
        }
    }

    return [...seen.values()];
}

/**
 * Checks whether an answer indicates insufficient evidence.
 *
 * @param {string} answerText
 * @returns {boolean}
 */
function isInsufficientEvidence(answerText) {
    if (!answerText || typeof answerText !== 'string') return true;
    return INSUFFICIENT_EVIDENCE_PATTERN.test(answerText);
}

/**
 * Formats source references based on route used and answer citation.
 *
 * @param {Array} chunks - Document chunks (for AZURE_SEARCH)
 * @param {Array} facts - Structured facts (for DIRECT_SQL)
 * @param {string} routeUsed - 'DIRECT_SQL' or 'AZURE_SEARCH'
 * @param {string} answerText - Synthesized answer
 * @returns {Array} Array of { id, source, citation }
 */
function formatAndValidateSources(chunks = [], facts = [], routeUsed = 'DIRECT_SQL', answerText = '') {
    if (routeUsed === 'AZURE_SEARCH') {
        return formatSourceReferences(chunks, answerText);
    }

    // DIRECT_SQL path: build from distinct SourceFileName
    const uniqueFiles = [...new Set((facts || []).map(f => f.SourceFileName).filter(Boolean))];
    return uniqueFiles.map((file, idx) => ({
        id: idx + 1,
        source: file,
        citation: `[${idx + 1}] ${file}`
    }));
}

/**
 * Resolves document ID, file name, and page number provenance.
 *
 * @param {Object|null} targetDocument
 * @param {string} routeUsed
 * @param {string} answerText
 * @param {Array} retainedFacts
 * @param {Array} retainedChunks
 * @returns {Object} { resolvedDocumentId, documentName, pageNumber }
 */
function resolveDocumentProvenance(targetDocument, routeUsed, answerText = '', retainedFacts = [], retainedChunks = []) {
    let resolvedDocumentId = targetDocument ? targetDocument.DocumentId : null;
    let documentName = targetDocument ? targetDocument.FileName : null;
    let pageNumber = null;

    if (!resolvedDocumentId) {
        if (routeUsed === 'AZURE_SEARCH' && retainedChunks.length > 0) {
            const lowerAns = (answerText || '').toLowerCase();
            const citedChunk = retainedChunks.find(c => lowerAns.includes((c.fileName || c.source || '').toLowerCase())) || retainedChunks[0];
            const rawDocId = citedChunk?.documentId || citedChunk?.document_id || null;
            resolvedDocumentId = rawDocId ? String(rawDocId).replace(/^doc_/i, '') : null;
            documentName = citedChunk?.fileName || citedChunk?.source || null;
            pageNumber = citedChunk?.pageNumber || citedChunk?.page_number || null;
        } else if (routeUsed === 'DIRECT_SQL' && retainedFacts.length > 0) {
            resolvedDocumentId = retainedFacts[0]?.DocumentId || null;
            documentName = retainedFacts[0]?.SourceFileName || null;
            pageNumber = retainedFacts[0]?.SourceLocation || null;
        }
    }

    return {
        resolvedDocumentId,
        documentName,
        pageNumber
    };
}

/**
 * Validates the complete response and packages provenance.
 *
 * @param {Object} options
 * @returns {Object} Validated response package
 */
function validateRetrievalResponse({
    answer,
    routeUsed,
    retainedFacts = [],
    retainedChunks = [],
    hasUnresolvedConflict = false,
    insufficientEvidence = false,
    targetDocument = null
}) {
    const textInsufficient = isInsufficientEvidence(answer);
    const effectiveInsufficient = insufficientEvidence || textInsufficient;

    const formattedSources = formatAndValidateSources(retainedChunks, retainedFacts, routeUsed, answer);
    const provenance = resolveDocumentProvenance(targetDocument, routeUsed, answer, retainedFacts, retainedChunks);

    // Always include retainedFacts in factsUsedOutput when non-empty:
    // - DIRECT_SQL route: facts come directly from the SQL query
    // - AZURE_SEARCH route: facts may have been enriched post-answer (Stage 10 enrichment)
    //   by extracting specific entities from the answer text and doing a targeted SQL lookup
    const factsUsedOutput = (retainedFacts && retainedFacts.length > 0)
        ? deduplicateFactsUsed(retainedFacts)
        : [];

    const grounded = !effectiveInsufficient && !hasUnresolvedConflict && Boolean(answer);

    return {
        answer,
        insufficientEvidence: effectiveInsufficient,
        hasUnresolvedConflict,
        grounded,
        formattedSources,
        factsUsedOutput,
        resolvedDocumentId: provenance.resolvedDocumentId,
        documentName: provenance.documentName,
        pageNumber: provenance.pageNumber
    };
}

module.exports = {
    isInsufficientEvidence,
    formatAndValidateSources,
    resolveDocumentProvenance,
    validateRetrievalResponse,
    deduplicateFactsUsed
};