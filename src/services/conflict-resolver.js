require('../utils/config');
const { areValuesEqual } = require('./unit-normalizer');
const { getPool } = require('./sql');
const sql = require('mssql');

/**
 * Detect conflicts across documents for the same metric, entity, and period.
 * 
 * Rules:
 * 1. Exact equality filtering: If values are equal (areValuesEqual), ignore (no conflict).
 * 2. Zero Auto-Resolution: When values differ, always flag conflict with status 'Pending Review'.
 * 3. Enriched Provenance: Extracts existing document's uploader and authority to formulate clear notifications.
 *
 * @param {number|string} [targetDocId=null] - Optional DocumentId of newly ingested document
 * @returns {Promise<Array<Object>>} List of detected conflicts with full provenance
 */
async function detectAndResolveConflicts(targetDocId = null) {
    const pool = await getPool();
    const docIdNum = targetDocId ? Number(targetDocId) : null;

    let query = `
        SELECT f.FactId, f.DocumentId, f.Metric, f.Entity, f.PeriodLabel,
               f.NumericValue, f.TextValue, f.Unit, f.Currency, f.SourceLocation,
               ISNULL(f.AuthorityRank, d.AuthorityRank) AS AuthorityRank,
               d.FileName AS SourceFileName,
               d.CreatedByName, d.CreatedByEmail,
               d.ModifiedByName, d.ModifiedByEmail,
               d.IngestionStatus,
               f.CreatedAt AS FactCreatedAt,
               r.SourceType AS AuthorityType
        FROM dbo.FinancialFacts f
        JOIN dbo.Documents d ON f.DocumentId = d.DocumentId
        LEFT JOIN dbo.SourceAuthorityRanks r ON ISNULL(f.AuthorityRank, d.AuthorityRank) = r.AuthorityRank
        WHERE f.NumericValue IS NOT NULL
          AND (d.IngestionStatus = 'Succeeded' 
               OR d.IngestionStatus = 'Processing' 
               OR d.IngestionStatus = 'Pending Review' 
               OR @DocId IS NOT NULL AND d.DocumentId = @DocId 
               OR d.IngestionStatus IS NULL)
    `;

    const req = pool.request();
    req.input('DocId', sql.BigInt, docIdNum);
    const result = await req.query(query);
    const allFacts = result.recordset;

    // Group facts by metric + entity + period
    const grouped = new Map();
    for (const f of allFacts) {
        const key = `${(f.Metric || '').trim().toLowerCase()}|${(f.Entity || 'global').trim().toLowerCase()}|${(f.PeriodLabel || 'general').trim().toLowerCase()}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(f);
    }

    const detectedConflicts = [];

    for (const [, factsInGroup] of grouped.entries()) {
        if (factsInGroup.length < 2) continue;

        // If targetDocId is provided, only inspect groups that contain facts from targetDocId
        if (docIdNum && !factsInGroup.some(f => f.DocumentId === docIdNum)) {
            continue;
        }

        // Compare each pair in the group
        for (let i = 0; i < factsInGroup.length; i++) {
            for (let j = i + 1; j < factsInGroup.length; j++) {
                let f1 = factsInGroup[i];
                let f2 = factsInGroup[j];

                // Skip facts from the same document or same file name
                if (f1.DocumentId === f2.DocumentId) continue;
                if (f1.SourceFileName && f2.SourceFileName &&
                    f1.SourceFileName.toLowerCase() === f2.SourceFileName.toLowerCase()) {
                    continue;
                }

                // If targetDocId is given, ensure f2 is the newly uploaded document fact
                if (docIdNum) {
                    if (f1.DocumentId === docIdNum && f2.DocumentId !== docIdNum) {
                        const temp = f1;
                        f1 = f2;
                        f2 = temp;
                    } else if (f2.DocumentId !== docIdNum) {
                        continue;
                    }
                }

                const existingFact = f1;
                const uploadedFact = f2;

                // Rule 1: Exact equality -> ignore
                const isIdentical = areValuesEqual(existingFact.NumericValue, uploadedFact.NumericValue);
                if (isIdentical) {
                    continue;
                }

                // Rule 2: Values differ -> Conflict Detected (Never auto-resolve based on rank)
                const diff = Number((uploadedFact.NumericValue - existingFact.NumericValue).toFixed(4));
                const resolutionStatus = 'Pending Review';

                const existingUploader = existingFact.ModifiedByName || 
                                         existingFact.CreatedByName || 
                                         existingFact.ModifiedByEmail || 
                                         existingFact.CreatedByEmail || 
                                         existingFact.AuthorityType || 
                                         'Authority Source';

                const existingDocName = existingFact.SourceFileName || 'existing document';
                const uploadedDocName = uploadedFact.SourceFileName || 'uploaded document';

                const conflictNarrative = `FinChat already has a document uploaded by ${existingUploader} with document name "${existingDocName}" which has conflicts with your uploaded document "${uploadedDocName}" on metric "${uploadedFact.Metric}": ${existingFact.NumericValue} ${existingFact.Currency || ''} vs ${uploadedFact.NumericValue} ${uploadedFact.Currency || ''} (Difference: ${diff > 0 ? '+' + diff : diff}).`;
                const proposedResolution = `Confirmation required: Verify whether new figure (${uploadedFact.NumericValue}) from "${uploadedDocName}" supersedes existing figure (${existingFact.NumericValue}) from "${existingDocName}".`;

                await pool.request()
                    .input('F1', existingFact.FactId)
                    .input('F2', uploadedFact.FactId)
                    .input('Reason', `Value mismatch: ${existingFact.NumericValue} vs ${uploadedFact.NumericValue}`)
                    .input('Status', resolutionStatus)
                    .input('Notes', conflictNarrative)
                    .input('Proposed', proposedResolution)
                    .query(`
                        IF NOT EXISTS (
                            SELECT 1 FROM dbo.FactConflicts 
                            WHERE (FactId1 = @F1 AND FactId2 = @F2) OR (FactId1 = @F2 AND FactId2 = @F1)
                        )
                        BEGIN
                            INSERT INTO dbo.FactConflicts (FactId1, FactId2, ConflictReason, ResolutionStatus, ResolutionNotes, ProposedResolution, CreatedAt)
                            VALUES (@F1, @F2, @Reason, @Status, @Notes, @Proposed, SYSUTCDATETIME());
                        END
                        ELSE
                        BEGIN
                            UPDATE dbo.FactConflicts 
                            SET ResolutionStatus = @Status, ResolutionNotes = @Notes, ProposedResolution = @Proposed
                            WHERE (FactId1 = @F1 AND FactId2 = @F2) OR (FactId1 = @F2 AND FactId2 = @F1);
                        END
                    `);

                detectedConflicts.push({
                    fact1: existingFact,
                    fact2: uploadedFact,
                    existingFileName: existingDocName,
                    uploadedFileName: uploadedDocName,
                    existingUploader,
                    existingValue: existingFact.NumericValue,
                    uploadedValue: uploadedFact.NumericValue,
                    metric: uploadedFact.Metric,
                    period: uploadedFact.PeriodLabel,
                    entity: uploadedFact.Entity,
                    currency: uploadedFact.Currency,
                    difference: diff,
                    status: resolutionStatus,
                    notes: conflictNarrative,
                    proposedResolution
                });
            }
        }
    }

    return detectedConflicts;
}

/**
 * Returns facts for a document annotated with active conflict governance information.
 */
async function getFactsWithConflictContext(documentId = null) {
    const pool = await getPool();

    let query = `
        SELECT f.FactId, f.DocumentId, f.Metric, f.Entity, f.PeriodLabel, f.FactDate,
               f.NumericValue, f.TextValue, f.Unit, f.Currency, f.SourceLocation,
               ISNULL(f.AuthorityRank, d.AuthorityRank) AS AuthorityRank,
               f.ValidationStatus, f.CreatedAt,
               d.FileName AS SourceFileName,
               r.SourceType AS AuthorityType
        FROM dbo.FinancialFacts f
        JOIN dbo.Documents d ON f.DocumentId = d.DocumentId
        LEFT JOIN dbo.SourceAuthorityRanks r ON ISNULL(f.AuthorityRank, d.AuthorityRank) = r.AuthorityRank
        WHERE (d.IngestionStatus = 'Succeeded' OR d.IngestionStatus = 'Pending Review' OR d.IngestionStatus IS NULL)
    `;

    if (documentId) {
        const numId = Number(documentId);
        if (!isNaN(numId) && numId > 0) {
            query += ` AND f.DocumentId = ${numId}`;
        }
    }

    query += ' ORDER BY f.FactId ASC';
    const factsResult = await pool.request().query(query);
    const facts = factsResult.recordset;

    const conflictsResult = await pool.request().query(`
        SELECT ConflictId, FactId1, FactId2, ConflictReason, ResolutionStatus, ResolutionNotes, ProposedResolution
        FROM dbo.FactConflicts
    `);
    const conflicts = conflictsResult.recordset;

    return facts.map(fact => {
        const activeConflict = conflicts.find(c => c.FactId1 === fact.FactId || c.FactId2 === fact.FactId);
        if (activeConflict) {
            return {
                ...fact,
                hasConflict: true,
                conflictId: activeConflict.ConflictId,
                conflictStatus: activeConflict.ResolutionStatus,
                conflictExplanation: activeConflict.ResolutionNotes,
                proposedResolution: activeConflict.ProposedResolution
            };
        }
        return {
            ...fact,
            hasConflict: false,
            conflictStatus: null,
            conflictExplanation: null,
            proposedResolution: null
        };
    });
}

module.exports = {
    detectAndResolveConflicts,
    getFactsWithConflictContext
};
