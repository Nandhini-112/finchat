const { TOKEN_LIMITS, NOTE_LIMITS, HEADING_SYNONYMS } = require('../../config/chunking');
const {
    buildContextPrefix,
    classifyLanguage,
    estimateTokens,
    computeSearchText,
    splitIntoSentences
} = require('./normalizer');

/**
 * Builds table chunk(s) from a table block and its attached notes
 */
function createTableChunks(tableBlock, doc, tableSeq, options = {}) {
    const tableData = tableBlock.tableData || {};
    const tableId = `${doc.documentId}_t${tableSeq}`;
    const baseTitle = `${doc.entity || 'Document'} – ${tableData.sheetName ? `Sheet ${tableData.sheetName}` : 'Table'} – ${doc.periodLabel || ''}`.replace(/\s*–\s*–/g, ' –').trim();

    // Check attached notes
    const attachedNotes = tableBlock.attachedNotes || [];
    let fullTableMarkdown = tableBlock.content || '';
    if (attachedNotes.length > 0) {
        fullTableMarkdown += `\n\nNotes:\n${attachedNotes.join('\n')}`;
    }

    const lang = classifyLanguage(fullTableMarkdown);
    const tokens = estimateTokens(fullTableMarkdown, lang);

    // If within tableMaxTokens (1000 tokens), return single chunk
    if (tokens <= TOKEN_LIMITS.tableMaxTokens) {
        const prefix = buildContextPrefix(doc, 'table');
        const content = `${prefix}\n${fullTableMarkdown}`;
        const chunkLang = classifyLanguage(content);

        return [{
            chunk_type: 'table',
            title: baseTitle,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: tableBlock.pageNumber || 1,
            page_end: tableBlock.pageNumber || 1,
            section_title: tableData.sheetName || `Table ${tableSeq}`,
            table_id: tableId,
            table_part: 1,
            table_parts: 1,
            qa_flags: []
        }];
    }

    // Otherwise, split large table into row groups
    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    if (rows.length === 0 || headers.length === 0) {
        // Fallback if rows cannot be parsed cleanly
        const prefix = buildContextPrefix(doc, 'table');
        const content = `${prefix}\n${fullTableMarkdown}`;
        const chunkLang = classifyLanguage(content);
        return [{
            chunk_type: 'table',
            title: baseTitle,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: tableBlock.pageNumber || 1,
            page_end: tableBlock.pageNumber || 1,
            section_title: tableData.sheetName || `Table ${tableSeq}`,
            table_id: tableId,
            table_part: 1,
            table_parts: 1,
            qa_flags: ['oversized_table_unsplit']
        }];
    }

    const headerLine = `| ${headers.join(' | ')} |`;
    const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
    const headerPrefixTokens = estimateTokens(`${headerLine}\n${sepLine}\n`, lang);
    const maxRowTokens = TOKEN_LIMITS.tableMaxTokens - headerPrefixTokens - 100;

    const rowGroups = [];
    let currentRowGroup = [];
    let currentTokens = 0;

    for (const row of rows) {
        const rowLine = `| ${headers.map(h => row.cells[h] || '').join(' | ')} |`;
        const rowTokens = estimateTokens(rowLine, lang);

        if (currentRowGroup.length > 0 && currentTokens + rowTokens > maxRowTokens) {
            rowGroups.push(currentRowGroup);
            currentRowGroup = [rowLine];
            currentTokens = rowTokens;
        } else {
            currentRowGroup.push(rowLine);
            currentTokens += rowTokens;
        }
    }
    if (currentRowGroup.length > 0) {
        rowGroups.push(currentRowGroup);
    }

    const totalParts = rowGroups.length;
    const chunks = [];

    rowGroups.forEach((groupRows, pIdx) => {
        const partNumber = pIdx + 1;
        let partMarkdown = [headerLine, sepLine, ...groupRows].join('\n');
        // Attach notes to the last part if present
        if (partNumber === totalParts && attachedNotes.length > 0) {
            partMarkdown += `\n\nNotes:\n${attachedNotes.join('\n')}`;
        }

        const prefix = buildContextPrefix(doc, 'table');
        const content = `${prefix}\n${partMarkdown}`;
        const chunkLang = classifyLanguage(content);

        chunks.push({
            chunk_type: 'table',
            title: `${baseTitle} (Part ${partNumber} of ${totalParts})`,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: tableBlock.pageNumber || 1,
            page_end: tableBlock.pageNumber || 1,
            section_title: tableData.sheetName || `Table ${tableSeq}`,
            table_id: tableId,
            table_part: partNumber,
            table_parts: totalParts,
            qa_flags: ['table_split']
        });
    });

    return chunks;
}

/**
 * Builds narrative chunks (commentary or section) with sentence splitting and overlap
 */
function createNarrativeChunks(text, chunkType, sectionTitle, doc, pageStart, pageEnd, attachedSignature = null) {
    const baseTitle = `${doc.entity || 'Document'} – ${sectionTitle || (chunkType === 'commentary' ? 'Commentary' : 'Section')} – ${doc.periodLabel || ''}`.replace(/\s*–\s*–/g, ' –').trim();
    const lang = classifyLanguage(text);
    const tokens = estimateTokens(text, lang);

    let fullBody = text;
    if (attachedSignature) {
        fullBody = `${text}\n${attachedSignature}`;
    }

    // If within target limit
    if (tokens <= TOKEN_LIMITS.targetCommentary) {
        const prefix = buildContextPrefix(doc, chunkType, sectionTitle);
        const content = `${prefix}\n${fullBody}`;
        const chunkLang = classifyLanguage(content);

        return [{
            chunk_type: chunkType,
            title: baseTitle,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: pageStart,
            page_end: pageEnd,
            section_title: sectionTitle,
            table_id: null,
            table_part: null,
            table_parts: null,
            qa_flags: []
        }];
    }

    // Oversized narrative: split on sentence boundaries with ~12% overlap
    const sentences = splitIntoSentences(text);
    if (sentences.length <= 1) {
        // Fallback: single chunk even if slightly over target, up to hardCap
        const prefix = buildContextPrefix(doc, chunkType, sectionTitle);
        const content = `${prefix}\n${fullBody}`;
        const chunkLang = classifyLanguage(content);
        return [{
            chunk_type: chunkType,
            title: baseTitle,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: pageStart,
            page_end: pageEnd,
            section_title: sectionTitle,
            table_id: null,
            table_part: null,
            table_parts: null,
            qa_flags: []
        }];
    }

    const targetTokens = TOKEN_LIMITS.targetCommentary;
    const overlapSentencesCount = Math.max(1, Math.round(sentences.length * TOKEN_LIMITS.narrativeOverlapRatio));

    const sentenceGroups = [];
    let currentGroup = [];
    let currentToks = 0;

    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        const sToks = estimateTokens(s, lang);

        if (currentGroup.length > 0 && currentToks + sToks > targetTokens) {
            sentenceGroups.push(currentGroup);
            // Overlap: retain last N sentences
            const overlap = currentGroup.slice(-overlapSentencesCount);
            currentGroup = [...overlap, s];
            currentToks = overlap.reduce((sum, item) => sum + estimateTokens(item, lang), 0) + sToks;
        } else {
            currentGroup.push(s);
            currentToks += sToks;
        }
    }
    if (currentGroup.length > 0) {
        sentenceGroups.push(currentGroup);
    }

    const totalParts = sentenceGroups.length;
    const chunks = [];

    sentenceGroups.forEach((group, idx) => {
        const partNumber = idx + 1;
        let partText = group.join(' ');
        if (partNumber === totalParts && attachedSignature) {
            partText += `\n${attachedSignature}`;
        }

        const prefix = buildContextPrefix(doc, chunkType, sectionTitle);
        const content = `${prefix}\n${partText}`;
        const chunkLang = classifyLanguage(content);

        chunks.push({
            chunk_type: chunkType,
            title: `${baseTitle} (Part ${partNumber} of ${totalParts})`,
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: pageStart,
            page_end: pageEnd,
            section_title: sectionTitle,
            table_id: null,
            table_part: partNumber,
            table_parts: totalParts,
            qa_flags: []
        });
    });

    return chunks;
}

/**
 * Creates chunks for a single parsed document version.
 * Emits:
 * 1. Exactly 1 'card' chunk
 * 2. 'table' chunks with attached notes or split row groups
 * 3. 'commentary' chunks with attached signature
 * 4. 'section' chunks for other titled sections or oversized notes
 * 5. 'other' chunks for unclassified blocks or standalone signatures
 */
function chunkDocument(doc, options = {}) {
    const rawChunks = [];
    const blocks = doc.blocks || [];
    let droppedBlocks = 0;

    // 1. Emit Summary Card Chunk
    const cardPrefix = buildContextPrefix(doc, 'card');
    const cardDetails = [];
    if (doc.status) cardDetails.push(`Status: ${doc.status}`);
    if (doc.version !== null) cardDetails.push(`Version: ${doc.version}`);
    if (doc.preparedDate) cardDetails.push(`Prepared: ${doc.preparedDate}`);
    if (doc.approvedDate) cardDetails.push(`Approved: ${doc.approvedDate}`);
    if (doc.audited !== null) cardDetails.push(`Audited: ${doc.audited ? 'Yes' : 'No'}`);
    if (doc.supersedesText) cardDetails.push(`Supersedes: ${doc.supersedesText}`);

    const cardContent = `${cardPrefix}\n${cardDetails.join(' | ')}`;
    const cardLang = classifyLanguage(cardContent);

    rawChunks.push({
        chunk_type: 'card',
        title: `${doc.entity || 'Document'} – Summary Card – ${doc.periodLabel || ''}`.replace(/\s*–\s*–/g, ' –').trim(),
        content: cardContent,
        search_text: computeSearchText(cardContent, cardLang),
        language: cardLang,
        page_start: 1,
        page_end: 1,
        section_title: 'Summary Card',
        table_id: null,
        table_part: null,
        table_parts: null,
        qa_flags: []
    });

    // 2. Process blocks: group notes with preceding table
    let tableSeq = 0;
    let i = 0;

    while (i < blocks.length) {
        const block = blocks[i];

        // --- TABLE BLOCK ---
        if (block.type === 'table') {
            tableSeq++;
            block.attachedNotes = [];
            let totalNoteChars = 0;

            // Look ahead for trailing notes/footnotes
            let nextIdx = i + 1;
            while (nextIdx < blocks.length) {
                const nextBlock = blocks[nextIdx];
                if (nextBlock.type === 'footnote' || (nextBlock.type === 'paragraph' && /^(?:notes?:|note\s+\d+|footnote\s+\d+|\d+\.\s+)/i.test(nextBlock.content))) {
                    const noteText = nextBlock.content;
                    if (noteText.length <= NOTE_LIMITS.maxSingleNoteChars &&
                        totalNoteChars + noteText.length <= NOTE_LIMITS.maxTotalAttachedNoteChars) {
                        block.attachedNotes.push(noteText);
                        totalNoteChars += noteText.length;
                        nextIdx++;
                    } else {
                        // Exceeds limit: will become its own section chunk
                        break;
                    }
                } else {
                    break;
                }
            }

            const tableChunks = createTableChunks(block, doc, tableSeq, options);
            rawChunks.push(...tableChunks);

            // Skip attached notes
            i = nextIdx;
            continue;
        }

        // --- HEADING BLOCK ---
        if (block.type === 'heading' || block.role === 'sectionHeading') {
            const headingText = block.content;
            const isCommentary = HEADING_SYNONYMS.commentary.some(rgx => rgx.test(headingText));
            const isUnclassified = /appendix|telemetry|sensor|debug|الملحق|إضافي|unclassified/i.test(headingText);

            // Gather subsequent paragraphs belonging to this heading
            const narrativeParts = [];
            let attachedSignature = block.attachedSignature || null;
            let pageStart = block.pageNumber || 1;
            let pageEnd = pageStart;

            let nextIdx = i + 1;
            while (nextIdx < blocks.length) {
                const nextBlock = blocks[nextIdx];
                if (nextBlock.type === 'heading' || nextBlock.type === 'table' || nextBlock.role === 'sectionHeading') {
                    break;
                }
                if (nextBlock.attachedSignature) {
                    attachedSignature = nextBlock.attachedSignature;
                }
                narrativeParts.push(nextBlock.content);
                pageEnd = nextBlock.pageNumber || pageEnd;
                nextIdx++;
            }

            const combinedNarrative = narrativeParts.join('\n\n').trim();
            if (combinedNarrative) {
                const chunkType = isUnclassified ? 'other' : (isCommentary ? 'commentary' : 'section');
                const narrativeWithHeading = `## ${headingText}\n${combinedNarrative}`;
                const narrativeChunks = createNarrativeChunks(
                    narrativeWithHeading,
                    chunkType,
                    headingText,
                    doc,
                    pageStart,
                    pageEnd,
                    attachedSignature
                );
                if (isUnclassified) {
                    narrativeChunks.forEach(c => c.qa_flags.push('unclassified'));
                }
                rawChunks.push(...narrativeChunks);
            }

            i = nextIdx;
            continue;
        }

        // --- STANDALONE FOOTNOTE / OVERSIZED NOTE ---
        if (block.type === 'footnote' || (block.type === 'paragraph' && /^(?:notes?:|note\s+\d+|footnote\s+\d+|\d+\.\s+)/i.test(block.content))) {
            const noteMatch = block.content.match(/^(?:Notes?:|Note\s+(\d+)|Footnote\s+(\d+)|\d+\.\s+)(.*)$/i);
            const noteNum = noteMatch ? (noteMatch[1] || noteMatch[2] || '1') : '1';
            const sectionTitle = `Note ${noteNum} – Financial Notes`;
            const associatedTableId = tableSeq > 0 ? `${doc.documentId}_t${tableSeq}` : null;

            const sectionChunks = createNarrativeChunks(
                block.content,
                'section',
                sectionTitle,
                doc,
                block.pageNumber || 1,
                block.pageNumber || 1,
                null
            );
            sectionChunks.forEach(c => {
                c.table_id = associatedTableId;
                c.qa_flags.push('note_detached');
            });
            rawChunks.push(...sectionChunks);
            i++;
            continue;
        }

        // --- STANDALONE PARAGRAPH WITHOUT HEADING ---
        if (block.type === 'paragraph') {
            const pText = block.content.trim();
            // Check if commentary based on text
            const isCommentary = HEADING_SYNONYMS.commentary.some(rgx => rgx.test(pText));
            const chunkType = isCommentary ? 'commentary' : 'section';
            const sectionTitle = isCommentary ? 'Commentary' : 'Narrative Section';

            const narrativeChunks = createNarrativeChunks(
                pText,
                chunkType,
                sectionTitle,
                doc,
                block.pageNumber || 1,
                block.pageNumber || 1,
                block.attachedSignature || null
            );
            rawChunks.push(...narrativeChunks);
            i++;
            continue;
        }

        // --- STANDALONE SIGNATURE OR UNCLASSIFIED / UNKNOWN ---
        if (block.type === 'unknown' || block.isStandaloneSignature || block.type === 'signature') {
            const prefix = buildContextPrefix(doc, 'other', 'Sign-off');
            const content = `${prefix}\n${block.content}`;
            const chunkLang = classifyLanguage(content);

            rawChunks.push({
                chunk_type: 'other',
                title: `${doc.entity || 'Document'} – Other – ${doc.periodLabel || ''}`.replace(/\s*–\s*–/g, ' –').trim(),
                content,
                search_text: computeSearchText(content, chunkLang),
                language: chunkLang,
                page_start: block.pageNumber || 1,
                page_end: block.pageNumber || 1,
                section_title: 'Other',
                table_id: null,
                table_part: null,
                table_parts: null,
                qa_flags: ['unclassified']
            });
            i++;
            continue;
        }

        // Any other block: never drop content
        const prefix = buildContextPrefix(doc, 'other', 'Appendix');
        const content = `${prefix}\n${block.content}`;
        const chunkLang = classifyLanguage(content);
        rawChunks.push({
            chunk_type: 'other',
            title: `${doc.entity || 'Document'} – Appendix – ${doc.periodLabel || ''}`.replace(/\s*–\s*–/g, ' –').trim(),
            content,
            search_text: computeSearchText(content, chunkLang),
            language: chunkLang,
            page_start: block.pageNumber || 1,
            page_end: block.pageNumber || 1,
            section_title: 'Appendix',
            table_id: null,
            table_part: null,
            table_parts: null,
            qa_flags: ['unclassified']
        });
        i++;
    }

    // 3. Finalize IDs and chunk indices
    const totalChunkCount = rawChunks.length;
    const finalChunks = rawChunks.map((chunk, idx) => {
        // Enforce deterministic ID: ${document_id}_${chunk_type}_${idx}
        const id = `${doc.documentId}_${chunk.chunk_type}_${idx}`;

        // Combine document QA flags with chunk QA flags
        const allFlags = [...new Set([...(doc.qaFlags || []), ...(chunk.qa_flags || [])])];

        return {
            id,
            document_id: doc.documentId,
            document_family_id: doc.documentFamilyId,
            chunk_type: chunk.chunk_type,
            chunk_index: idx,
            title: chunk.title,
            content: chunk.content,
            search_text: chunk.search_text,
            source: doc.sourceFileName,
            metadata: {
                entity: doc.entity,
                document_type: doc.documentType,
                period_label: doc.periodLabel,
                period_end: doc.periodEnd,
                currency: doc.currency,
                basis: doc.basis,
                status: doc.status,
                audited: doc.audited,
                version: doc.version,
                is_latest: doc.isLatest,
                supersedes: doc.supersedes,
                superseded_by: doc.supersededBy,
                prepared_date: doc.preparedDate,
                language: chunk.language,
                page_start: chunk.page_start,
                page_end: chunk.page_end,
                section_title: chunk.section_title,
                table_id: chunk.table_id,
                table_part: chunk.table_part,
                table_parts: chunk.table_parts,
                chunk_count: totalChunkCount,
                access_tags: options.accessTags || [],
                qa_flags: allFlags
            }
        };
    });

    return {
        chunks: finalChunks,
        droppedBlocks
    };
}

module.exports = {
    createTableChunks,
    createNarrativeChunks,
    chunkDocument
};
