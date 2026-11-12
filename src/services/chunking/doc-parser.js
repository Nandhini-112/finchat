const crypto = require('crypto');
const { METADATA_PATTERNS } = require('../../config/chunking');

function toAsciiDigits(str) {
    if (!str) return '';
    return String(str)
        .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0));
}

/**
 * Normalizes date strings (e.g. "16 July 2026", "2026-06-30", "٣٠ يونيو ٢٠٢٦") into ISO YYYY-MM-DD
 */
function normalizeDateToISO(dateStr) {
    if (!dateStr) return null;
    const clean = toAsciiDigits(String(dateStr).trim().replace(/^[,\s]+|[,\s]+$/g, ''));

    // Try standard ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;

    // Try standard JS Date parsing
    const parsed = new Date(clean);
    if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
    }

    // Try DD Month YYYY (English)
    const monthNamesEn = {
        january: '01', feb: '02', february: '02', mar: '03', march: '03', apr: '04', april: '04',
        may: '05', jun: '06', june: '06', jul: '07', july: '07', aug: '08', august: '08',
        sep: '09', september: '09', oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
    };

    const dmy = clean.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (dmy) {
        const m = monthNamesEn[dmy[2].toLowerCase()];
        if (m) {
            const day = dmy[1].padStart(2, '0');
            return `${dmy[3]}-${m}-${day}`;
        }
    }

    // Try DD Month YYYY (Arabic)
    const monthNamesAr = {
        'يناير': '01', 'فبراير': '02', 'مارس': '03', 'أبريل': '04', 'ابريل': '04',
        'مايو': '05', 'يونيو': '06', 'يوليو': '07', 'أغسطس': '08', 'اغسطس': '08',
        'سبتمبر': '09', 'أكتوبر': '10', 'اكتوبر': '10', 'نوفمبر': '11', 'ديسمبر': '12'
    };

    const dmyAr = clean.match(/^(\d{1,2})\s+([\u0621-\u064A]+)\s+(\d{4})$/);
    if (dmyAr) {
        const m = monthNamesAr[dmyAr[2]];
        if (m) {
            const day = dmyAr[1].padStart(2, '0');
            return `${dmyAr[3]}-${m}-${day}`;
        }
    }

    return null;
}

/**
 * Derives period_end ISO date from period label or quarter mention
 */
function derivePeriodEnd(periodLabel, text) {
    const combined = `${periodLabel || ''} ${text || ''}`;

    // Quarter ended date (e.g. "quarter ended 30 June 2026" or "٣٠ يونيو ٢٠٢٦")
    const dateMatch = combined.match(/(?:ended|ending|المنتهي\s+في)\s+([\d\u0660-\u0669]+\s+[A-Za-z\u0621-\u064A]+\s+[\d\u0660-\u0669]+|\d{4}-\d{2}-\d{2})/i);
    if (dateMatch) {
        const iso = normalizeDateToISO(dateMatch[1]);
        if (iso) return iso;
    }

    // Arabic quarter named (e.g. الربع الثاني ٢٠٢٦)
    const arQNames = { 'الأول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4 };
    const arQMatch = combined.match(/الربع\s+(الأول|الثاني|الثالث|الرابع|[1-4\u0661-\u0664])\s*([\d\u0660-\u0669]{2,4})/u);
    if (arQMatch) {
        const qNum = arQNames[arQMatch[1]] || Number(toAsciiDigits(arQMatch[1])) || 1;
        const year = toAsciiDigits(arQMatch[2]);
        const ends = { 1: '-03-31', 2: '-06-30', 3: '-09-30', 4: '-12-31' };
        return `${year}${ends[qNum]}`;
    }

    // Quarter pattern (Q1 2026 => 2026-03-31, Q2 2026 => 2026-06-30, etc.)
    const qMatch = combined.match(/\bQ([1-4])\s*(20\d\d)\b/i) || combined.match(/الربع\s+([1-4])\s+(20\d\d)/u);
    if (qMatch) {
        const q = Number(qMatch[1]);
        const year = qMatch[2];
        const ends = { 1: '-03-31', 2: '-06-30', 3: '-09-30', 4: '-12-31' };
        return `${year}${ends[q]}`;
    }

    // FY pattern (FY2026 => 2026-12-31)
    const fyMatch = combined.match(/\bFY\s*(20\d\d)\b/i) || combined.match(/السنة\s+المالية\s+([\d\u0660-\u0669]{2,4})/u);
    if (fyMatch) {
        const year = toAsciiDigits(fyMatch[1]);
        return `${year}-12-31`;
    }

    return null;
}

/**
 * Parses header metadata from text blocks without inventing defaults
 */
function parseMetadataFromText(fullHeaderText, fileName = '') {
    const qaFlags = [];

    // 1. Entity
    let entity = null;
    for (const pattern of METADATA_PATTERNS.entity) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            let ent = (match[1] || match[0]).trim();
            ent = ent.replace(/^(?:We have audited the financial statements of|Independent auditor'?s? report on|In our opinion)\s+/i, '').trim();
            entity = ent;
            break;
        }
    }
    if (!entity) {
        qaFlags.push('missing_entity');
    }

    // 2. Document Type
    let documentType = null;
    for (const item of METADATA_PATTERNS.documentType) {
        if (item.pattern.test(fullHeaderText) || item.pattern.test(fileName)) {
            documentType = item.type;
            break;
        }
    }
    if (!documentType) {
        qaFlags.push('missing_document_type');
    }

    // 3. Period Label & End
    let periodLabel = null;
    for (const pattern of METADATA_PATTERNS.period) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            periodLabel = (match[1] || match[0]).trim();
            break;
        }
    }
    if (!periodLabel) {
        qaFlags.push('missing_period');
    }
    const periodEnd = derivePeriodEnd(periodLabel, fullHeaderText);

    // 4. Currency
    let currency = null;
    for (const item of METADATA_PATTERNS.currency) {
        if (item.pattern.test(fullHeaderText)) {
            currency = item.code;
            break;
        }
    }
    if (!currency) {
        qaFlags.push('missing_currency');
    }

    // 5. Status
    let status = null;
    const statusLineMatch = fullHeaderText.match(/(?:^|\n)\s*(?:status|الحالة):\s*([^\n\r]+)/i);
    if (statusLineMatch) {
        const line = statusLineMatch[1];
        if (/\bdraft\b|\bsuperseded\b|\bnot approved\b|مسودة/i.test(line)) {
            status = 'draft';
        } else if (/\bfinal\b|نهائي/i.test(line)) {
            status = 'final';
        } else if (/\bapproved\b|معتمد/i.test(line)) {
            status = 'approved';
        }
    }
    if (!status) {
        const firstLine = fullHeaderText.split('\n')[0] || '';
        for (const item of METADATA_PATTERNS.status) {
            if (item.pattern.test(firstLine)) {
                status = item.status;
                break;
            }
        }
    }
    if (!status) {
        qaFlags.push('missing_status');
    }

    // 6. Audited Status (Unaudited MUST be tested before audited)
    let audited = null;
    for (const item of METADATA_PATTERNS.auditOrder) {
        if (item.pattern.test(fullHeaderText)) {
            audited = item.audited;
            break;
        }
    }
    if (audited === null) {
        qaFlags.push('missing_audit_status');
    }

    // 7. Version (Word-bounded \bv(?:ersion)?\s*(\d+))
    let version = null;
    for (const pattern of METADATA_PATTERNS.version) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            version = Number(toAsciiDigits(match[1]));
            break;
        }
    }
    if (version === null) {
        qaFlags.push('missing_version');
    }

    // 8. Basis (actual, budget, draft, forecast)
    let basis = null;
    for (const item of METADATA_PATTERNS.basis) {
        if (item.pattern.test(fullHeaderText)) {
            basis = item.basis;
            break;
        }
    }
    if (!basis) {
        if (status === 'draft') {
            basis = 'draft';
        } else {
            qaFlags.push('missing_basis');
        }
    }

    // 9. Supersedes Text
    let supersedesText = null;
    for (const pattern of METADATA_PATTERNS.supersedesText) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            supersedesText = (match[0]).trim();
            break;
        }
    }

    // 10. Dates (Prepared & Approved)
    let preparedDate = null;
    for (const pattern of METADATA_PATTERNS.preparedDate) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            preparedDate = normalizeDateToISO(match[1]);
            break;
        }
    }

    let approvedDate = null;
    for (const pattern of METADATA_PATTERNS.approvedDate) {
        const match = fullHeaderText.match(pattern);
        if (match) {
            approvedDate = normalizeDateToISO(match[1]);
            break;
        }
    }

    // 11. Document Title
    let title = null;
    const titleMatch = fullHeaderText.match(/(?:Management Pack|Financial Statements|Statement of Profit or Loss|Budget Workbook|القوائم المالية|تقرير الإدارة)[^\n\r]*/i);
    if (titleMatch) {
        title = titleMatch[0].trim();
    } else if (entity && documentType) {
        title = `${entity} - ${documentType}${periodLabel ? ` - ${periodLabel}` : ''}`;
    }

    return {
        entity,
        title,
        documentType,
        periodLabel,
        periodEnd,
        currency,
        status,
        audited,
        version,
        supersedesText,
        preparedDate,
        approvedDate,
        basis,
        qaFlags
    };
}

/**
 * Checks if a block is an introductory header line signaling the start of a document
 */
function isDocumentStartCandidate(block) {
    if (!block || !block.content) return false;
    const text = block.content.trim();

    // Notes or footnotes NEVER start a new document
    if (block.type === 'footnote' || /^(?:notes?:|note\s+\d+|footnote\s+\d+|\d+\.\s+)/i.test(text)) {
        return false;
    }

    // Auditor opinions / reports inside notes never start a new document
    if (/^(?:We have audited|In our opinion|Dated\s+\d|–\s*Senior\s+Audit\s+Partner)/i.test(text)) {
        return false;
    }

    // Check entity + document type or entity + version or entity + period
    const hasEntity = METADATA_PATTERNS.entity.some(p => p.test(text));
    const hasDocType = METADATA_PATTERNS.documentType.some(p => p.pattern.test(text));
    const hasVersion = METADATA_PATTERNS.version.some(p => p.test(text));
    const hasPeriod = METADATA_PATTERNS.period.some(p => p.test(text));
    const hasStatus = METADATA_PATTERNS.status.some(p => p.pattern.test(text));

    return hasEntity && (hasDocType || hasVersion || hasPeriod || hasStatus);
}

/**
 * Splits a list of typed blocks into individual document partitions.
 * A new document starts where a running header or title changes entity, status, prepared date, or version.
 */
function splitIntoDocuments(blocks, options = {}) {
    if (!blocks || blocks.length === 0) return [];

    const partitions = [];
    let currentBlocks = [];
    let currentHeaderTokens = null;

    const extractHeaderTokens = (b) => {
        const text = b.content || '';
        let entity = null;
        for (const p of METADATA_PATTERNS.entity) {
            const m = text.match(p);
            if (m) { entity = m[1].trim(); break; }
        }
        let version = null;
        for (const p of METADATA_PATTERNS.version) {
            const m = text.match(p);
            if (m) { version = Number(toAsciiDigits(m[1])); break; }
        }
        let status = null;
        for (const p of METADATA_PATTERNS.status) {
            if (p.pattern.test(text)) { status = p.status; break; }
        }
        return { entity, version, status };
    };

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        if (isDocumentStartCandidate(block)) {
            const tokens = extractHeaderTokens(block);
            if (currentBlocks.length > 0 && currentHeaderTokens) {
                // If entity, version, or status differs, this is a new document!
                const isDiff = (tokens.entity && tokens.entity !== currentHeaderTokens.entity) ||
                               (tokens.version !== null && currentHeaderTokens.version !== null && tokens.version !== currentHeaderTokens.version) ||
                               (tokens.status && currentHeaderTokens.status && tokens.status !== currentHeaderTokens.status);

                if (isDiff) {
                    partitions.push(currentBlocks);
                    currentBlocks = [block];
                    currentHeaderTokens = tokens;
                    continue;
                }
            } else if (!currentHeaderTokens) {
                currentHeaderTokens = tokens;
            }
        }

        currentBlocks.push(block);
    }

    if (currentBlocks.length > 0) {
        partitions.push(currentBlocks);
    }

    return partitions;
}

/**
 * Splits input blocks into document versions, parses metadata, and removes layout noise.
 */
function splitAndParseDocuments(blocks, options = {}) {
    if (!blocks || blocks.length === 0) return [];

    const rawPartitions = splitIntoDocuments(blocks, options);
    const documents = [];
    const baseDocId = options.documentId ? String(options.documentId).replace(/^doc_/, '') : null;
    const fileName = options.fileName || 'document.pdf';

    rawPartitions.forEach((docBlocks, pIdx) => {
        // Collect text from the first few blocks (header, title, initial paragraphs) to parse metadata
        const headerBlockCount = Math.min(docBlocks.length, 6);
        const headerText = docBlocks.slice(0, headerBlockCount).map(b => b.content).join('\n');

        // Check if any watermark exists in this partition
        const watermarkBlock = docBlocks.find(b => b.type === 'watermark' || METADATA_PATTERNS.watermarkDraft.test(b.content));
        const metadata = parseMetadataFromText(headerText, fileName);

        if (watermarkBlock && !metadata.status) {
            metadata.status = 'draft';
            // remove missing_status flag
            const qIdx = metadata.qaFlags.indexOf('missing_status');
            if (qIdx !== -1) metadata.qaFlags.splice(qIdx, 1);
        }

        // Noise removal: filter out running headers, page numbers, and standalone watermarks
        let passedHeaderZone = false;
        const cleanedBlocks = [];
        for (const b of docBlocks) {
            // Once we encounter a table, heading, or substantial narrative, header zone ends
            if (b.type === 'table' || b.type === 'heading' || b.role === 'sectionHeading') {
                passedHeaderZone = true;
            }

            // In header zone, introductory lines that define the document title/status/prepared/entity/currency are header metadata
            if (!passedHeaderZone && (b.type === 'paragraph' || b.type === 'title' || b.type === 'header')) {
                const text = b.content || '';
                const isHeaderInfo = METADATA_PATTERNS.entity.some(p => p.test(text)) ||
                                     METADATA_PATTERNS.documentType.some(p => p.pattern.test(text)) ||
                                     METADATA_PATTERNS.status.some(p => p.pattern.test(text)) ||
                                     METADATA_PATTERNS.preparedDate.some(p => p.test(text)) ||
                                     METADATA_PATTERNS.currency.some(p => p.pattern.test(text)) ||
                                     METADATA_PATTERNS.version.some(p => p.test(text));
                if (isHeaderInfo) {
                    continue;
                }
            }

            // Drop running headers (already captured into metadata)
            if (b.type === 'header' || b.role === 'pageHeader') continue;

            // Drop page numbers / footers
            if (b.role === 'pageNumber' || /^(?:<!--\s*Page\s+\d+\s*-->|Page\s+\d+\s+of\s+\d+)$/i.test(b.content)) continue;

            // Drop watermark
            if (b.type === 'watermark' || METADATA_PATTERNS.watermarkDraft.test(b.content)) continue;

            cleanedBlocks.push(b);
        }

        // Generate stable documentId
        let docId;
        if (baseDocId) {
            docId = rawPartitions.length > 1 ? `doc_${baseDocId}_p${pIdx + 1}` : `doc_${baseDocId}`;
        } else {
            const hash = crypto.createHash('sha256')
                .update(`${fileName}#${metadata.entity || 'unknown'}#${metadata.version || pIdx}#${metadata.preparedDate || ''}`)
                .digest('hex').slice(0, 8);
            docId = `doc_${hash}`;
        }

        documents.push({
            documentId: docId,
            entity: metadata.entity,
            title: metadata.title,
            documentType: metadata.documentType,
            periodLabel: metadata.periodLabel,
            periodEnd: metadata.periodEnd,
            currency: metadata.currency,
            status: metadata.status,
            audited: metadata.audited,
            version: metadata.version,
            supersedesText: metadata.supersedesText,
            preparedDate: metadata.preparedDate,
            approvedDate: metadata.approvedDate,
            basis: metadata.basis,
            sourceFileName: fileName,
            qaFlags: metadata.qaFlags,
            blocks: cleanedBlocks
        });
    });

    return documents;
}

module.exports = {
    normalizeDateToISO,
    derivePeriodEnd,
    parseMetadataFromText,
    splitIntoDocuments,
    splitAndParseDocuments
};
