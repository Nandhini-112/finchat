const { areValuesEqual } = require('./unit-normalizer');
const { getPool } = require('./sql');

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
    `;

    const result = await pool.request().query(query);
    const allFacts = result.recordset;

    const grouped = new Map();
    for (const f of allFacts) {
        const key = `${(f.Metric || '').trim().toLowerCase()}|${(f.Entity || 'global').trim().toLowerCase()}|${(f.PeriodLabel || 'general').trim().toLowerCase()}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(f);
    }

    const detectedConflicts = [];

    for (const [, factsInGroup] of grouped.entries()) {
        if (factsInGroup.length < 2) continue;

        factsInGroup.sort((a, b) => (a.AuthorityRank || 4) - (b.AuthorityRank || 4));
        const authoritative = factsInGroup[0];

        for (let i = 1; i < factsInGroup.length; i++) {
            const comparison = factsInGroup[i];
            if (authoritative.DocumentId === comparison.DocumentId) continue;

            const isIdentical = areValuesEqual(authoritative.NumericValue, comparison.NumericValue);

            if (!isIdentical) {
                const diff = (comparison.NumericValue - authoritative.NumericValue).toFixed(2);
                const reason = `Mismatch for ${authoritative.Metric} (${authoritative.Entity || 'Global'}): ${authoritative.NumericValue} (${authoritative.AuthorityType || 'Rank ' + authoritative.AuthorityRank}) vs ${comparison.NumericValue} (${comparison.AuthorityType || 'Rank ' + comparison.AuthorityRank}). Variance: ${diff}`;

                await pool.request()
                    .input('F1', authoritative.FactId)
                    .input('F2', comparison.FactId)
                    .input('Reason', reason)
                    .query(`
                        IF NOT EXISTS (
                            SELECT 1 FROM dbo.FactConflicts 
                            WHERE (FactId1 = @F1 AND FactId2 = @F2) OR (FactId1 = @F2 AND FactId2 = @F1)
                        )
                        BEGIN
                            INSERT INTO dbo.FactConflicts (FactId1, FactId2, ConflictReason, ResolutionStatus, CreatedAt)
                            VALUES (@F1, @F2, @Reason, 'Resolved', SYSUTCDATETIME());
                        END
                    `);

                detectedConflicts.push({ fact1: authoritative, fact2: comparison, reason });
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
    `;

    if (documentId) {
        const numId = Number(documentId);
        if (!isNaN(numId) && numId > 0) {
            query += ` WHERE f.DocumentId = ${numId}`;
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
