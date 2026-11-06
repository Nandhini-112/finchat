function findRelevantStructuredFacts(question, facts = []) {
    if (!facts || facts.length === 0) return [];

    const q = question.toLowerCase();
    const relevant = [];

    const getEntity = f => (f.Entity || f.entity || '');
    const getMetric = f => (f.Metric || f.metric || '');

    // Transaction ID search (e.g. TXN-10004)
    const txnMatch = q.match(/txn-\d+/i);
    if (txnMatch) {
        const targetTxn = txnMatch[0].toUpperCase();
        relevant.push(...facts.filter(f => getEntity(f).toUpperCase().includes(targetTxn)));
    }

    if (q.includes('pending')) {
        relevant.push(...facts.filter(f => /pending/i.test(getEntity(f)) || /pending/i.test(getMetric(f))));
    }

    if (q.includes('approved')) {
        relevant.push(...facts.filter(f => /approved/i.test(getEntity(f)) || /approved/i.test(getMetric(f))));
    }

    if (q.includes('declined')) {
        relevant.push(...facts.filter(f => /declined/i.test(getEntity(f)) || /declined/i.test(getMetric(f))));
    }

    if (q.includes('total') || q.includes('count') || q.includes('amount') || q.includes('summary')) {
        relevant.push(...facts.filter(f => /all transactions/i.test(getEntity(f)) || /total/i.test(getMetric(f))));
    }

    if (q.includes('mismatch') || q.includes('exception') || q.includes('discrepancy') || q.includes('difference') || q.includes('conflict') || q.includes('variance')) {
        relevant.push(...facts.filter(f =>
            /mismatch/i.test(getMetric(f)) ||
            /gateway/i.test(getMetric(f)) ||
            /settlement/i.test(getMetric(f)) ||
            f.hasConflict === true
        ));
    }

    if (relevant.length === 0) {
        return facts.slice(0, 10);
    }

    // Deduplicate facts
    const seen = new Set();
    return relevant.filter(f => {
        const key = f.FactId ? String(f.FactId) : `${f.DocumentId || ''}_${getMetric(f)}_${getEntity(f)}_${f.NumericValue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatSourceReferences(retrievedChunks) {
    if (!retrievedChunks || retrievedChunks.length === 0) return [];

    return retrievedChunks.map(chunk => {
        let pageNumber = Number(chunk.pageNumber);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
            pageNumber = 1;
            const pageMatch = (chunk.title || '').match(/Page\s+(\d+)/i) || (chunk.content || '').match(/Page\s+(\d+)/i);
            if (pageMatch) pageNumber = parseInt(pageMatch[1], 10);
        }

        return {
            source: chunk.fileName || chunk.source || 'Unknown',
            fileLink: chunk.fileLink || null,
            chunkId: chunk.id,
            title: chunk.title || chunk.heading || 'Section',
            pageNumber,
            department: chunk.department || null,
            jobTitle: chunk.jobTitle || null,
            authorityRank: chunk.authorityRank ?? null,
            authoritySource: chunk.authoritySource || null,
            documentKey: chunk.documentKey || null,
            queueKey: chunk.queueKey || null
        };
    });
}

module.exports = {
    findRelevantStructuredFacts,
    formatSourceReferences
};
