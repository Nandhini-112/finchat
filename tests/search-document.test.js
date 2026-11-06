const test = require('node:test');
const assert = require('node:assert/strict');
const {
    EXTENDED_INDEX_FIELDS,
    buildChunkId,
    buildSearchDocument,
    resolveDocumentKey,
    resolveQueueKey,
    toLegacySearchDocument
} = require('../src/services/search-document');

const vector = () => Array(1536).fill(0.1);

test('manual chunk ids stay compatible with the existing document id pattern', () => {
    assert.equal(buildChunkId({ documentId: 15, chunkIndex: 0 }), 'doc_15_chunk_0');
    assert.equal(buildChunkId({ documentId: 15, chunkIndex: 2 }), 'doc_15_chunk_2');
});

test('queue chunk ids are stable, safe, and different per version', () => {
    const first = buildChunkId({ queueKey: 'drive|item|1.0', documentId: 4, chunkIndex: 0 });
    const again = buildChunkId({ queueKey: 'drive|item|1.0', documentId: 99, chunkIndex: 0 });
    const nextVersion = buildChunkId({ queueKey: 'drive|item|2.0', documentId: 4, chunkIndex: 0 });

    assert.equal(first, again);
    assert.notEqual(first, nextVersion);
    assert.match(first, /^[A-Za-z0-9_\-=]+$/);
    assert.doesNotMatch(first, /\|/);
});

test('document and queue keys prefer the SharePoint columns', () => {
    const record = {
        DocumentKey: 'stored-document',
        QueueKey: 'stored-queue',
        DriveId: 'drive',
        DriveItemId: 'item',
        FileVersion: '3.0'
    };
    assert.equal(resolveDocumentKey(record), 'stored-document');
    assert.equal(resolveQueueKey(record), 'stored-queue');
});

test('document and queue keys are composed when the list columns are empty', () => {
    const record = { DriveId: 'drive', DriveItemId: 'item', FileVersion: '1.0' };
    assert.equal(resolveDocumentKey(record), 'drive|item');
    assert.equal(resolveQueueKey(record), 'drive|item|1.0');
});

test('search document carries provenance and keeps the vector', () => {
    const document = buildSearchDocument({
        chunk: {
            id: 'doc_8_chunk_0',
            title: 'Policy - Leave',
            content: 'Leave is 30 days.',
            source: 'policy.pdf',
            heading: 'Leave',
            pageNumber: 2,
            chunkIndex: 0
        },
        contentVector: vector(),
        metadata: {
            documentId: 8,
            documentKey: 'drive|item',
            queueKey: 'drive|item|1.0',
            fileName: 'policy.pdf',
            fileLink: 'https://example.sharepoint.com/policy.pdf',
            department: 'Finance',
            jobTitle: 'Controller',
            authorityRank: 2,
            modifiedDate: '2026-10-30T05:57:01Z'
        }
    });

    assert.equal(document.id, 'doc_8_chunk_0');
    assert.equal(document.content, 'Leave is 30 days.');
    assert.equal(document.documentKey, 'drive|item');
    assert.equal(document.queueKey, 'drive|item|1.0');
    assert.equal(document.department, 'Finance');
    assert.equal(document.jobTitle, 'Controller');
    assert.equal(document.authorityRank, 2);
    assert.equal(document.authoritySource, 'DocumentRank');
    assert.equal(document.pageNumber, 2);
    assert.equal(Object.hasOwn(document, 'isCurrent'), false);
    assert.equal(document.contentVector.length, 1536);
    assert.equal(document.modifiedDate, '2026-10-30T05:57:01.000Z');
});

test('legacy projection keeps only the original index fields', () => {
    const full = buildSearchDocument({
        chunk: { id: 'doc_1_chunk_0', content: 'text', source: 'a.pdf', chunkIndex: 0 },
        contentVector: vector(),
        metadata: { documentId: 1, fileName: 'a.pdf', authorityRank: 4 }
    });
    const legacy = toLegacySearchDocument(full);
    assert.deepEqual(Object.keys(legacy), ['id', 'title', 'content', 'source', 'contentVector']);
});

test('extended index fields do not replace the existing search fields', () => {
    const names = EXTENDED_INDEX_FIELDS.map(field => field.name);
    for (const existing of ['id', 'title', 'content', 'source', 'contentVector']) {
        assert.equal(names.includes(existing), false);
    }
    assert.equal(names.includes('authorityRank'), true);
    assert.equal(names.includes('isCurrent'), false);
});

test('invalid search keys and vectors are rejected', () => {
    assert.throws(() => buildSearchDocument({
        chunk: { id: 'bad|key', content: 'text' },
        contentVector: vector()
    }), /rejects/);

    assert.throws(() => buildSearchDocument({
        chunk: { id: 'doc_1_chunk_0', content: 'text' },
        contentVector: [1, 2, 3]
    }), /1536/);
});
