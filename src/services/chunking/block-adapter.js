const { METADATA_PATTERNS } = require('../../config/chunking');

/**
 * Parses a markdown pipe table string into structured headers and rows.
 */
function parseMarkdownPipeTable(markdownText) {
    const lines = markdownText.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
    if (lines.length < 2) return null;

    const parseRow = (line) => {
        // Strip leading and trailing pipe and split by pipe
        const inner = line.slice(1, -1);
        return inner.split('|').map(c => c.trim());
    };

    const headers = parseRow(lines[0]);
    // Check if second line is a separator (| --- | --- |)
    let dataStartIdx = 1;
    if (lines.length > 1 && /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[1])) {
        dataStartIdx = 2;
    }

    const rows = [];
    for (let i = dataStartIdx; i < lines.length; i++) {
        const rawValues = parseRow(lines[i]);
        // Avoid purely blank rows
        if (rawValues.every(v => v === '')) continue;
        const rowObj = {};
        headers.forEach((h, colIdx) => {
            rowObj[h || `Col_${colIdx + 1}`] = rawValues[colIdx] || '';
        });
        rows.push({
            rowIndex: rows.length + 1,
            cells: rowObj,
            rawValues
        });
    }

    return {
        headers,
        rows,
        rowCount: rows.length + 1,
        columnCount: headers.length,
        markdown: lines.join('\n')
    };
}

/**
 * Builds markdown table from raw grid / cells
 */
function buildMarkdownTable(headers, rows) {
    const headerLine = `| ${headers.join(' | ')} |`;
    const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataLines = rows.map(r => `| ${headers.map(h => (r.cells && r.cells[h] !== undefined ? r.cells[h] : '')).join(' | ')} |`);
    return [headerLine, separatorLine, ...dataLines].join('\n');
}

/**
 * Adapts any raw or normalized extracted document into typed blocks.
 * Supported input shapes:
 * 1. Normalized Document ({ document_id, fullMarkdown, tables, paragraphs })
 * 2. Document Intelligence Layout ({ content, pages, tables, paragraphs })
 * 3. Excel Extraction ({ pages, tables, paragraphs, content })
 * 4. Plain text / Markdown string or buffer
 */
function adaptToBlocks(extracted, options = {}) {
    if (!extracted) return [];

    // If extracted is a string or Buffer
    if (typeof extracted === 'string' || Buffer.isBuffer(extracted)) {
        return adaptTextOrMarkdown(extracted.toString('utf8'), options);
    }

    // If extracted is already normalized or from DI
    const tables = extracted.tables || [];
    const paragraphs = extracted.paragraphs || [];
    const rawContent = extracted.fullMarkdown || extracted.content || '';

    // If we have explicit tables and paragraphs from DI or normalizer
    if (tables.length > 0 || paragraphs.length > 0) {
        return adaptStructuredLayout(extracted, options);
    }

    // Otherwise fallback to text parser on content
    return adaptTextOrMarkdown(rawContent, options);
}

/**
 * Adapts structured extraction with tables and paragraphs
 */
function adaptStructuredLayout(extracted, options = {}) {
    const blocks = [];
    const tables = extracted.tables || [];
    const paragraphs = extracted.paragraphs || [];
    const pageTables = new Map();

    // Index tables
    tables.forEach((t, idx) => {
        const page = t.page_number || t.boundingRegions?.[0]?.pageNumber || 1;
        if (!pageTables.has(page)) pageTables.set(page, []);

        let headers = t.headers || [];
        let rows = t.rows || [];
        let markdown = t.content || '';

        // If cells exist without headers/rows (raw DI output)
        if ((!headers.length || !rows.length) && t.cells) {
            const rowCount = t.rowCount || 0;
            const colCount = t.columnCount || 0;
            const grid = Array.from({ length: rowCount }, () => Array(colCount).fill(''));
            for (const cell of t.cells) {
                if (cell.rowIndex < rowCount && cell.columnIndex < colCount) {
                    grid[cell.rowIndex][cell.columnIndex] = (cell.content || '').replace(/\r?\n/g, ' ').trim();
                }
            }
            headers = grid[0] ? grid[0].map((h, i) => h || `Col_${i + 1}`) : [];
            rows = [];
            for (let r = 1; r < rowCount; r++) {
                const rowObj = {};
                for (let c = 0; c < colCount; c++) {
                    rowObj[headers[c] || `Col_${c + 1}`] = grid[r][c] || '';
                }
                rows.push({ rowIndex: r, cells: rowObj, rawValues: grid[r] });
            }
            markdown = buildMarkdownTable(headers, rows);
        }

        pageTables.get(page).push({
            type: 'table',
            content: markdown,
            pageNumber: page,
            role: 'table',
            tableData: {
                tableId: t.table_id || idx + 1,
                headers,
                rows,
                markdown,
                sheetName: t.sheetName || null,
                rowCount: t.rowCount || (rows.length + 1),
                columnCount: t.columnCount || headers.length
            }
        });
    });

    // Process paragraphs
    const sortedParagraphs = [...paragraphs].sort((a, b) => {
        const pA = a.page_number || a.boundingRegions?.[0]?.pageNumber || 1;
        const pB = b.page_number || b.boundingRegions?.[0]?.pageNumber || 1;
        return pA - pB;
    });

    let currentHeading = null;

    sortedParagraphs.forEach(p => {
        const content = (p.content || '').trim();
        if (!content) return;

        const page = p.page_number || p.boundingRegions?.[0]?.pageNumber || 1;
        const role = p.role || null;

        // Check watermark
        if (METADATA_PATTERNS.watermarkDraft.test(content)) {
            blocks.push({
                type: 'watermark',
                content,
                pageNumber: page,
                role: 'watermark'
            });
            return;
        }

        // Check signature
        if (METADATA_PATTERNS.signature.some(rgx => rgx.test(content))) {
            blocks.push({
                type: 'signature',
                content,
                pageNumber: page,
                role: 'signature'
            });
            return;
        }

        // Role-based or pattern-based classification
        if (role === 'pageHeader') {
            blocks.push({ type: 'header', content, pageNumber: page, role });
        } else if (role === 'pageFooter' || role === 'pageNumber') {
            blocks.push({ type: 'footnote', content, pageNumber: page, role });
        } else if (role === 'title') {
            blocks.push({ type: 'title', content, pageNumber: page, role });
        } else if (role === 'sectionHeading' || /^#{1,4}\s+/.test(content)) {
            currentHeading = content.replace(/^#{1,4}\s+/, '').trim();
            blocks.push({ type: 'heading', content, pageNumber: page, role: 'sectionHeading' });
        } else if (role === 'footnote' || /^(?:notes?:|note\s+\d+|footnote\s+\d+|\d+\.\s+)/i.test(content)) {
            blocks.push({ type: 'footnote', content, pageNumber: page, role: 'footnote' });
        } else {
            blocks.push({
                type: 'paragraph',
                content,
                pageNumber: page,
                role: null,
                currentHeading
            });
        }
    });

    // Insert tables on their respective pages
    for (const [page, tList] of pageTables.entries()) {
        blocks.push(...tList);
    }

    return blocks;
}

/**
 * Adapts raw markdown or plain text with headings, tables, and notes
 */
function adaptTextOrMarkdown(text, options = {}) {
    const blocks = [];
    const lines = text.split(/\r?\n/);
    let currentPage = 1;
    let tableBuffer = [];
    let paragraphBuffer = [];

    const flushTable = () => {
        if (tableBuffer.length === 0) return;
        const tableText = tableBuffer.join('\n');
        const parsed = parseMarkdownPipeTable(tableText);
        if (parsed && parsed.rows.length > 0) {
            blocks.push({
                type: 'table',
                content: parsed.markdown,
                pageNumber: currentPage,
                role: 'table',
                tableData: {
                    tableId: blocks.filter(b => b.type === 'table').length + 1,
                    headers: parsed.headers,
                    rows: parsed.rows,
                    markdown: parsed.markdown,
                    rowCount: parsed.rowCount,
                    columnCount: parsed.columnCount
                }
            });
        } else {
            // Not a valid table, flush as paragraph
            blocks.push({
                type: 'paragraph',
                content: tableText,
                pageNumber: currentPage,
                role: null
            });
        }
        tableBuffer = [];
    };

    const flushParagraph = () => {
        if (paragraphBuffer.length === 0) return;
        const pText = paragraphBuffer.join('\n').trim();
        paragraphBuffer = [];
        if (!pText) return;

        // Check if paragraph is watermark
        if (METADATA_PATTERNS.watermarkDraft.test(pText)) {
            blocks.push({ type: 'watermark', content: pText, pageNumber: currentPage, role: 'watermark' });
            return;
        }

        // Check if paragraph is signature
        if (METADATA_PATTERNS.signature.some(rgx => rgx.test(pText))) {
            blocks.push({ type: 'signature', content: pText, pageNumber: currentPage, role: 'signature' });
            return;
        }

        // Check if footnote/notes
        if (/^(?:notes?:|note\s+\d+|footnote\s+\d+|\d+\.\s+|\[\d+\])/i.test(pText)) {
            blocks.push({ type: 'footnote', content: pText, pageNumber: currentPage, role: 'footnote' });
            return;
        }

        // Regular paragraph
        blocks.push({
            type: 'paragraph',
            content: pText,
            pageNumber: currentPage,
            role: null
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Check page marker
        const pageMatch = trimmed.match(/^(?:<!--\s*Page\s+(\d+)\s*-->|\f|Page\s+(\d+)\s+of\s+\d+)$/i);
        if (pageMatch) {
            flushParagraph();
            flushTable();
            currentPage = Number(pageMatch[1] || pageMatch[2]) || (currentPage + 1);
            continue;
        }

        // Pipe table line
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushParagraph();
            tableBuffer.push(trimmed);
            continue;
        } else if (tableBuffer.length > 0) {
            // If table was collecting and we hit a non-pipe line
            // Check if blank line inside table
            if (!trimmed && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
                // blank line inside table, ignore layout noise
                continue;
            }
            flushTable();
        }

        // Blank line: flushes current paragraph
        if (!trimmed) {
            flushParagraph();
            continue;
        }

        // Markdown headings
        if (/^#{1,4}\s+/.test(trimmed)) {
            flushParagraph();
            blocks.push({
                type: 'heading',
                content: trimmed.replace(/^#{1,4}\s+/, '').trim(),
                pageNumber: currentPage,
                role: 'sectionHeading'
            });
            continue;
        }

        // Standalone watermark
        if (METADATA_PATTERNS.watermarkDraft.test(trimmed)) {
            flushParagraph();
            blocks.push({
                type: 'watermark',
                content: trimmed,
                pageNumber: currentPage,
                role: 'watermark'
            });
            continue;
        }

        // Standalone signature
        if (METADATA_PATTERNS.signature.some(rgx => rgx.test(trimmed))) {
            flushParagraph();
            blocks.push({
                type: 'signature',
                content: trimmed,
                pageNumber: currentPage,
                role: 'signature'
            });
            continue;
        }

        // Accumulate into paragraph
        paragraphBuffer.push(line);
    }

    flushParagraph();
    flushTable();

    return blocks;
}

module.exports = {
    adaptToBlocks,
    parseMarkdownPipeTable,
    buildMarkdownTable
};

