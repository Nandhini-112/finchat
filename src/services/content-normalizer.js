function normalizeTable(table, tableIndex, documentId) {
    const rowCount = table.rowCount || 0;
    const colCount = table.columnCount || 0;
    const grid = Array.from({ length: rowCount }, () => Array(colCount).fill(''));

    for (const cell of (table.cells || [])) {
        const r = cell.rowIndex;
        const c = cell.columnIndex;
        if (r < rowCount && c < colCount) {
            grid[r][c] = (cell.content || '').replace(/\r?\n/g, ' ').trim();
        }
    }

    const headers = grid[0] ? grid[0].map((h, i) => h || `Col_${i + 1}`) : [];
    const rows = [];

    for (let r = 1; r < rowCount; r++) {
        const rowObj = {};
        for (let c = 0; c < colCount; c++) {
            const headerName = headers[c] || `Col_${c + 1}`;
            rowObj[headerName] = grid[r][c] || '';
        }
        rows.push({
            rowIndex: r,
            cells: rowObj,
            rawValues: grid[r]
        });
    }

    const headerLine = `| ${headers.join(' | ')} |`;
    const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataLines = rows.map(row => `| ${headers.map(h => row.cells[h] || '').join(' | ')} |`);
    const markdown = [headerLine, separatorLine, ...dataLines].join('\n');

    const pageNumber = table.boundingRegions?.[0]?.pageNumber || 1;

    return {
        element_id: `doc_${documentId}_table_${tableIndex + 1}`,
        document_id: documentId,
        element_type: 'table',
        table_id: tableIndex + 1,
        row_count: rowCount,
        column_count: colCount,
        headers,
        rows,
        page_number: pageNumber,
        content: markdown
    };
}

function normalizeContent(analyzeResult, documentId) {
    const tables = (analyzeResult.tables || []).map((t, idx) => normalizeTable(t, idx, documentId));

    const paragraphs = (analyzeResult.paragraphs || []).map((p, idx) => {
        const pageNumber = p.boundingRegions?.[0]?.pageNumber || 1;
        return {
            element_id: `doc_${documentId}_p_${idx + 1}`,
            document_id: documentId,
            element_type: 'paragraph',
            content: (p.content || '').trim(),
            page_number: pageNumber
        };
    });

    return {
        document_id: documentId,
        tables,
        paragraphs,
        fullMarkdown: analyzeResult.content || ''
    };
}

module.exports = {
    normalizeTable,
    normalizeContent
};
