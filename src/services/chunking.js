const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

function createChunks(normalizedDoc, fileName, chunkSize = null, chunkOverlap = null) {
    const size = chunkSize || Number(process.env.CHUNK_SIZE) || DEFAULT_CHUNK_SIZE;
    const overlap = chunkOverlap || Number(process.env.CHUNK_OVERLAP) || DEFAULT_CHUNK_OVERLAP;

    const documentId = normalizedDoc.document_id;
    const rawContent = normalizedDoc.fullMarkdown || '';
    const tables = normalizedDoc.tables || [];

    const chunks = [];
    let chunkIndex = 0;

    const sections = rawContent.split(/(?=\n#{1,3}\s+)/);

    for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;

        const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/m);
        const sectionTitle = headingMatch ? headingMatch[1].trim() : `Section ${chunkIndex + 1}`;

        if (trimmed.length <= size) {
            chunks.push({
                id: `doc_${documentId}_chunk_${chunkIndex++}`,
                title: `${fileName} - ${sectionTitle}`,
                content: trimmed,
                source: fileName,
                documentId,
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
                    chunks.push({
                        id: `doc_${documentId}_chunk_${chunkIndex++}`,
                        title: `${fileName} - ${sectionTitle} (Part ${subIndex + 1})`,
                        content: piece,
                        source: fileName,
                        documentId,
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
            chunks.push({
                id: `doc_${documentId}_chunk_${chunkIndex++}`,
                title: `${fileName} - Table ${table.table_id} (Page ${table.page_number})`,
                content: table.content,
                source: fileName,
                documentId,
                pageNumber: table.page_number,
                sectionTitle: `Table ${table.table_id}`
            });
        }
    }

    return chunks;
}

module.exports = {
    createChunks
};
