const { areValuesEqual } = require('./unit-normalizer');
const { getPool } = require('./sql');

/**
 * Detect and resolve conflicts across documents for the same metric, entity, and period.
 * Rules:
 * 1. Authority rank priority: Audited Financials (Rank 1) > Board Packs / Final (Rank 2) > Drafts (Rank 3) > Sample/Test (Rank 4).
 * 2. If ranks differ: Higher authority is adopted as authoritative; status = 'Resolved (Higher Authority Adopted)'.
 * 3. If ranks are EQUAL: Flags as 'Unresolved - Review Required' rather than arbitrarily picking one.
 */
async function detectAndResolveConflicts(documentId = null) {
    const pool = await getPool();

    let query = `
        SELECT f.FactId, f.DocumentId, f.Metric, f.Entity, f.PeriodLabel,
               f.NumericValue, f.TextValue, f.Unit, f.Currency, f.SourceLocation,
               ISNULL(f.AuthorityRank, d.AuthorityRank) AS AuthorityRank,
               d.FileName AS SourceFileName,
               r.SourceType AS AuthorityType
        FROM dbo.FinancialFacts f
        JOIN dbo.Documents d ON f.DocumentId = d.DocumentId
        LEFT JOIN dbo.SourceAuthorityRanks r ON ISNULL(f.AuthorityRank, d.AuthorityRank) = r.AuthorityRank
        WHERE f.NumericValue IS NOT NULL
          AND (d.IngestionStatus = 'Succeeded' OR d.IngestionStatus IS NULL)
    `;

    const result = await pool.request().query(query);
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

        // Sort ascending by authority rank (Rank 1 is highest authority)
        factsInGroup.sort((a, b) => (a.AuthorityRank || 4) - (b.AuthorityRank || 4));
        const highestAuthFact = factsInGroup[0];

        for (let i = 1; i < factsInGroup.length; i++) {
            const comparisonFact = factsInGroup[i];
            if (highestAuthFact.DocumentId === comparisonFact.DocumentId) continue;

            // Do not flag a conflict between two records from the same file (e.g. re-ingested copies or multi-page entries)
            if (highestAuthFact.SourceFileName && comparisonFact.SourceFileName &&
                highestAuthFact.SourceFileName.toLowerCase() === comparisonFact.SourceFileName.toLowerCase()) {
                continue;
            }

            const isIdentical = areValuesEqual(highestAuthFact.NumericValue, comparisonFact.NumericValue);

            if (!isIdentical) {
                const diff = Number((comparisonFact.NumericValue - highestAuthFact.NumericValue).toFixed(4));
                const rank1 = highestAuthFact.AuthorityRank || 4;
                const rank2 = comparisonFact.AuthorityRank || 4;

                let resolutionStatus = 'Resolved';
                let resolutionNotes = '';

                if (rank1 < rank2) {
                    // Different ranks: Highest authority wins
                    resolutionStatus = 'Resolved (Higher Authority Adopted)';
                    resolutionNotes = `Discrepancy for ${highestAuthFact.Metric}: Adopted ${highestAuthFact.AuthorityType || 'Rank ' + rank1} from "${highestAuthFact.SourceFileName}" (${highestAuthFact.NumericValue} ${highestAuthFact.Currency}) over lower-authority ${comparisonFact.AuthorityType || 'Rank ' + rank2} from "${comparisonFact.SourceFileName}" (${comparisonFact.NumericValue} ${comparisonFact.Currency}). Difference: ${diff}.`;
                } else {
                    // Equal ranks: DO NOT pick one; flag for review
                    resolutionStatus = 'Unresolved - Review Required';
                    resolutionNotes = `Equal-rank disagreement for ${highestAuthFact.Metric}: "${highestAuthFact.SourceFileName}" reports ${highestAuthFact.NumericValue} ${highestAuthFact.Currency} while "${comparisonFact.SourceFileName}" reports ${comparisonFact.NumericValue} ${comparisonFact.Currency} (both hold ${highestAuthFact.AuthorityType || 'Rank ' + rank1}). Flagged for human review. Difference: ${diff}.`;
                }

                await pool.request()
                    .input('F1', highestAuthFact.FactId)
                    .input('F2', comparisonFact.FactId)
                    .input('Reason', `Value mismatch: ${highestAuthFact.NumericValue} vs ${comparisonFact.NumericValue}`)
                    .input('Status', resolutionStatus)
                    .input('Notes', resolutionNotes)
                    .query(`
                        IF NOT EXISTS (
                            SELECT 1 FROM dbo.FactConflicts 
                            WHERE (FactId1 = @F1 AND FactId2 = @F2) OR (FactId1 = @F2 AND FactId2 = @F1)
                        )
                        BEGIN
                            INSERT INTO dbo.FactConflicts (FactId1, FactId2, ConflictReason, ResolutionStatus, ResolutionNotes, CreatedAt)
                            VALUES (@F1, @F2, @Reason, @Status, @Notes, SYSUTCDATETIME());
                        END
                        ELSE
                        BEGIN
                            UPDATE dbo.FactConflicts 
                            SET ResolutionStatus = @Status, ResolutionNotes = @Notes
                            WHERE (FactId1 = @F1 AND FactId2 = @F2) OR (FactId1 = @F2 AND FactId2 = @F1);
                        END
                    `);

                detectedConflicts.push({
                    fact1: highestAuthFact,
                    fact2: comparisonFact,
                    difference: diff,
                    status: resolutionStatus,
                    notes: resolutionNotes
                });
            }
        }
    }

    return detectedConflicts;
}

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
        WHERE (d.IngestionStatus = 'Succeeded' OR d.IngestionStatus IS NULL)
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
        SELECT ConflictId, FactId1, FactId2, ConflictReason, ResolutionStatus, ResolutionNotes
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
                conflictExplanation: activeConflict.ResolutionNotes
            };
        }
        return {
            ...fact,
            hasConflict: false,
            conflictStatus: null,
            conflictExplanation: null
        };
    });
}

module.exports = {
    detectAndResolveConflicts,
    getFactsWithConflictContext
};
