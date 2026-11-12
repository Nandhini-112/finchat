const { HEADING_SYNONYMS } = require('../../config/chunking');

/**
 * Builds a deterministic slug from a string
 */
function slugify(text) {
    if (!text) return '';
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\u0621-\u064A]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Computes document_family_id for a document:
 * slug(entity) + '__' + slug(document_type) + '__' + period_end + '__' + slug(basis)
 * If entity, document_type, or period_end is missing, returns null.
 */
function computeDocumentFamilyId(doc) {
    if (!doc.entity || !doc.documentType || !doc.periodEnd) {
        return null;
    }

    const entitySlug = slugify(doc.entity);
    const typeSlug = slugify(doc.documentType);
    const periodEnd = doc.periodEnd; // YYYY-MM-DD
    const basisSlug = slugify(doc.basis || 'actual');

    if (!entitySlug || !typeSlug || !periodEnd) {
        return null;
    }

    return `${entitySlug}__${typeSlug}__${periodEnd}__${basisSlug}`;
}

/**
 * Checks if a block is a commentary heading or block
 */
function isCommentaryBlock(block) {
    if (!block || !block.content) return false;
    const text = block.content;

    if (block.type === 'heading' || block.role === 'sectionHeading') {
        return HEADING_SYNONYMS.commentary.some(rgx => rgx.test(text));
    }
    if (block.currentHeading) {
        return HEADING_SYNONYMS.commentary.some(rgx => rgx.test(block.currentHeading));
    }
    return false;
}

/**
 * Extracts entity mentioned in a signature line
 */
function extractEntityFromSignature(sigText) {
    if (!sigText) return null;
    // e.g. "– Chief Financial Officer, Contoso Logistics LLC (fictional)"
    const match = sigText.match(/(?:,\s*|\s+for\s+)([A-Za-z0-9&.,' -]+?(?:LLC|L\.L\.C\.|Corp|Inc|Ltd|Company|Holdings|Group))/i);
    if (match) return match[1].trim();

    // Check Contoso Entity patterns
    const contosoMatch = sigText.match(/(Contoso\s+[A-Za-z0-9& -]+?(?:LLC|Ltd|Corp)?)/i);
    if (contosoMatch) return contosoMatch[1].trim();

    return null;
}

/**
 * Reassigns signatures to the appropriate commentary block of the same entity.
 * Rule: A line such as "– Chief Financial Officer, <Entity> …" attaches to the commentary
 * of the SAME entity (nearest preceding, else the latest document of that entity whose commentary has no signature).
 * A standalone signature with no commentary goes into an 'other' chunk.
 */
function reassignSignatures(documents) {
    const allSignatures = [];

    // 1. Collect all signatures and remove them from doc blocks temporarily
    documents.forEach((doc, dIdx) => {
        const remainingBlocks = [];
        doc.blocks.forEach((block, bIdx) => {
            if (block.type === 'signature') {
                allSignatures.push({
                    signatureBlock: block,
                    sourceDocIndex: dIdx,
                    sourceBlockIndex: bIdx,
                    entity: extractEntityFromSignature(block.content) || doc.entity
                });
            } else {
                remainingBlocks.push(block);
            }
        });
        doc.blocks = remainingBlocks;
    });

    // 2. For each signature, find matching commentary candidate
    allSignatures.forEach(sig => {
        let targetDoc = null;
        let targetCommentaryBlock = null;

        // Try candidate docs matching entity
        const entityDocs = documents.filter(d => {
            if (!sig.entity || !d.entity) return false;
            return d.entity.toLowerCase().includes(sig.entity.toLowerCase()) ||
                   sig.entity.toLowerCase().includes(d.entity.toLowerCase());
        });

        // Search in entity docs: prefer latest document with commentary lacking signature
        // Sort descending by version
        const sortedDocs = [...entityDocs].sort((a, b) => (b.version || 0) - (a.version || 0));

        for (const doc of sortedDocs) {
            const commentaryBlock = doc.blocks.find(b => isCommentaryBlock(b) && !b.attachedSignature);
            if (commentaryBlock) {
                targetDoc = doc;
                targetCommentaryBlock = commentaryBlock;
                break;
            }
        }

        if (targetCommentaryBlock) {
            targetCommentaryBlock.attachedSignature = sig.signatureBlock.content;
        } else {
            // No matching commentary: return to source doc as standalone signature block
            const sourceDoc = documents[sig.sourceDocIndex];
            if (sourceDoc) {
                sourceDoc.blocks.push({
                    ...sig.signatureBlock,
                    type: 'unknown', // will become 'other' chunk
                    isStandaloneSignature: true
                });
            }
        }
    });
}

/**
 * Links versions within each document family and assigns is_latest, supersedes, and superseded_by.
 */
function linkVersionsAndFamilies(documents) {
    // 1. Reassign signatures first
    reassignSignatures(documents);

    // 2. Compute document_family_id for each document
    documents.forEach(doc => {
        doc.documentFamilyId = computeDocumentFamilyId(doc);
    });

    // 3. Group by document_family_id
    const families = new Map();
    documents.forEach(doc => {
        if (!doc.documentFamilyId) {
            doc.isLatest = null;
            doc.supersedes = null;
            doc.supersededBy = null;
            return;
        }
        if (!families.has(doc.documentFamilyId)) {
            families.set(doc.documentFamilyId, []);
        }
        families.get(doc.documentFamilyId).push(doc);
    });

    // 4. Link within each family
    for (const [familyId, famDocs] of families.entries()) {
        if (famDocs.length === 1) {
            const single = famDocs[0];
            single.isLatest = true;
            single.supersedes = null;
            single.supersededBy = null;
            continue;
        }

        // Sort ascending by version (v1, v2) or prepared date
        famDocs.sort((a, b) => {
            const vA = a.version !== null ? a.version : 0;
            const vB = b.version !== null ? b.version : 0;
            if (vA !== vB) return vA - vB;
            return (a.preparedDate || '').localeCompare(b.preparedDate || '');
        });

        // Set is_latest, supersedes, and superseded_by
        famDocs.forEach((doc, idx) => {
            const isLast = idx === famDocs.length - 1;
            doc.isLatest = isLast;

            // Preceding version
            if (idx > 0) {
                const prev = famDocs[idx - 1];
                doc.supersedes = prev.documentId;
                prev.supersededBy = doc.documentId;

                // Validate with supersedesText if present
                if (doc.supersedesText) {
                    const match = doc.supersedesText.match(/\bv(?:ersion)?\s*(\d+)/i);
                    if (match && prev.version !== null) {
                        const statedVer = Number(match[1]);
                        if (statedVer !== prev.version) {
                            doc.qaFlags.push('version_supersedes_mismatch');
                        }
                    }
                }
            } else {
                doc.supersedes = null;
            }

            if (isLast) {
                doc.supersededBy = null;
            }
        });
    }

    return documents;
}

module.exports = {
    slugify,
    computeDocumentFamilyId,
    isCommentaryBlock,
    reassignSignatures,
    linkVersionsAndFamilies
};

