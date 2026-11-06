const test = require('node:test');
const assert = require('node:assert/strict');
const { createChunks } = require('../src/services/chunking');

test('chunks keep heading and page, and versioned ids do not depend on the SQL id', () => {
    const normalized = {
        document_id: 12,
        fullMarkdown: '## Leave policy\n<!-- Page 2 -->\nEmployees receive 30 days.',
        tables: []
    };

    const first = createChunks(normalized, 'policy.pdf', 1000, 200, { queueKey: 'drive|item|1.0' });
    const reprocessed = createChunks(
        { ...normalized, document_id: 40 },
        'policy.pdf',
        1000,
        200,
        { queueKey: 'drive|item|1.0' }
    );

    assert.equal(first.length, 1);
    assert.equal(first[0].id, reprocessed[0].id);
    assert.equal(first[0].heading, 'Leave policy');
    assert.equal(first[0].pageNumber, 2);
    assert.equal(first[0].chunkIndex, 0);
    assert.match(first[0].id, /^qk_/);
});

test('chunks without a queue key keep the existing document id', () => {
    const chunks = createChunks({
        document_id: 7,
        fullMarkdown: 'Plain section',
        tables: []
    }, 'notes.pdf');

    assert.equal(chunks[0].id, 'doc_7_chunk_0');
});
