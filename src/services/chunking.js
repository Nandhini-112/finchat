const { buildChunkId } = require('./search-document');

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

function pageNumberFromText(text) {
    const matches = [...String(text || '').matchAll(/<!--\s*Page\s+(\d+)\s*-->/gi)];
    if (matches.length === 0) return null;
    const page = Number(matches[matches.length - 1][1]);
    return Number.isInteger(page) && page > 0 ? page : null;
}

function createChunks(normalizedDoc, fileName, chunkSize = null, chunkOverlap = null, options = null) {
    const size = chunkSize || Number(process.env.CHUNK_SIZE) || DEFAULT_CHUNK_SIZE;
    const overlap = chunkOverlap || Number(process.env.CHUNK_OVERLAP) || DEFAULT_CHUNK_OVERLAP;

    const documentId = normalizedDoc.document_id;
    const queueKey = options && options.queueKey;
    const rawContent = normalizedDoc.fullMarkdown || '';
    const tables = normalizedDoc.tables || [];

    const chunks = [];

    const pushChunk = (fields) => {
        const chunkIndex = chunks.length;
        chunks.push({
            ...fields,
            id: buildChunkId({ queueKey, documentId, chunkIndex }),
            chunkIndex,
            documentId,
            source: fileName
        });
    };

    const sections = rawContent.split(/(?=\n#{1,3}\s+)/);

    for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;

        const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/m);
        const sectionTitle = headingMatch ? headingMatch[1].trim() : `Section ${chunks.length + 1}`;

        if (trimmed.length <= size) {
            pushChunk({
                title: `${fileName} - ${sectionTitle}`,
                content: trimmed,
                heading: sectionTitle,
                pageNumber: pageNumberFromText(trimmed),
                sectionTitle
            });
        } else {
            let start = 0;
            let subIndex = 0;
            while (start < trimmed.length) {
                let end = start + size;
                if (end < trimmed.length) {
                    const nextNewline = trimmed.lastIndexOf('\n', end);
                    if (nextNewline > start + overlap) end = nextNewline;
                }

                const piece = trimmed.substring(start, end).trim();
                if (piece) {
                    pushChunk({
                        title: `${fileName} - ${sectionTitle} (Part ${subIndex + 1})`,
                        content: piece,
                        heading: sectionTitle,
                        pageNumber: pageNumberFromText(trimmed.slice(0, end)),
                        sectionTitle
                    });
                    subIndex++;
                }

                if (end >= trimmed.length) break;
                start = end - overlap;
            }
        }
    }

    for (const table of tables) {
        if (table.content && table.content.length > 50) {
            const heading = `Table ${table.table_id}`;
            pushChunk({
                title: `${fileName} - ${heading} (Page ${table.page_number})`,
                content: table.content,
                heading,
                pageNumber: table.page_number,
                sectionTitle: heading
            });
        }
    }

    return chunks;
}

module.exports = {
    createChunks
};
