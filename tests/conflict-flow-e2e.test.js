const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setPool, resetPool, createDocument, updateDocumentStatus, insertFinancialFacts, getDocumentById, getFinancialFacts, getAuditLogsForDocument, resolveDocumentConflict } = require('../src/services/sql');
const { detectAndResolveConflicts, getFactsWithConflictContext } = require('../src/services/conflict-resolver');
const { generateConflictResolutionToken, verifyConflictResolutionToken } = require('../src/services/conflict-token');
const { sendConflictNotificationEmail } = require('../src/services/notification');
const { resolveConflictHandler } = require('../src/functions/resolveConflict');
const { chatHandler } = require('../src/functions/chat');
const { updateQueueItemStatus } = require('../src/services/sharepoint-queue');

/**
 * Creates an in-memory SQL mock database for end-to-end testing
 */
function createMockSqlDb() {
    const documents = [];
    const facts = [];
    const conflicts = [];
    const auditLogs = [];
    let nextDocId = 1;
    let nextFactId = 100;
    let nextConflictId = 1;
    let nextAuditId = 1;

    const mockPool = {
        isMock: true,
        connected: true,
        data: { documents, facts, conflicts, auditLogs },
        request: () => {
            const inputs = {};
            const req = {
                input: (name, type, value) => {
                    inputs[name] = (value !== undefined) ? value : type;
                    return req;
                },
                query: async (queryText) => {
                    const trimmed = queryText.trim();

                    // 0. Ignore DDL / schema queries
                    if (trimmed.includes('sys.tables') || trimmed.includes('sys.columns') || trimmed.includes('CREATE TABLE') || trimmed.includes('ALTER TABLE')) {
                        return { recordset: [] };
                    }

                    // 1. Insert Document
                    if (trimmed.includes('INSERT INTO dbo.Documents')) {
                        const newDoc = {
                            DocumentId: nextDocId++,
                            FileName: inputs.FileName,
                            SourceType: inputs.SourceType || 'ManualUpload',
                            AuthorityRank: inputs.AuthorityRank || 4,
                            AllowedUserGroups: inputs.AllowedUserGroups || null,
                            IngestionStatus: 'Processing',
                            ModifiedByEmail: inputs.ModifiedByEmail || null,
                            ModifiedByName: inputs.ModifiedByName || null,
                            ModifiedByUserId: inputs.ModifiedByUserId || null,
                            CreatedByEmail: inputs.CreatedByEmail || null,
                            CreatedByName: inputs.CreatedByName || null,
                            CreatedByDepartment: inputs.CreatedByDepartment || null,
                            CreatedAt: new Date().toISOString()
                        };
                        documents.push(newDoc);
                        return { recordset: [{ DocumentId: newDoc.DocumentId }] };
                    }

                    // 2. Update Document Status
                    if (trimmed.startsWith('UPDATE dbo.Documents')) {
                        const doc = documents.find(d => d.DocumentId === inputs.DocumentId);
                        if (doc && inputs.Status) {
                            doc.IngestionStatus = inputs.Status;
                            doc.LastProcessedAt = new Date().toISOString();
                        }
                        return { rowsAffected: [1] };
                    }

                    // 3. Get Document By Id / FileName
                    if (trimmed.includes('FROM dbo.Documents WHERE DocumentId = @DocumentId')) {
                        const doc = documents.find(d => d.DocumentId === inputs.DocumentId);
                        return { recordset: doc ? [{ ...doc }] : [] };
                    }
                    if (trimmed.includes('FROM dbo.Documents WHERE FileName = @FileName')) {
                        const doc = documents.find(d => d.FileName === inputs.FileName);
                        return { recordset: doc ? [{ ...doc }] : [] };
                    }

                    // 4. Insert FinancialFacts
                    if (trimmed.includes('INSERT INTO dbo.FinancialFacts')) {
                        const newFact = {
                            FactId: nextFactId++,
                            DocumentId: inputs.DocumentId,
                            Metric: inputs.Metric,
                            Entity: inputs.Entity,
                            PeriodLabel: inputs.PeriodLabel,
                            FactDate: inputs.FactDate,
                            AsOfDate: inputs.AsOfDate,
                            NumericValue: inputs.NumericValue !== null && inputs.NumericValue !== undefined ? Number(inputs.NumericValue) : null,
                            TextValue: inputs.TextValue,
                            Unit: inputs.Unit,
                            Currency: inputs.Currency,
                            SourceLocation: inputs.SourceLocation,
                            SourceFileName: inputs.SourceFileName,
                            AuthorityRank: inputs.AuthorityRank,
                            ValidationStatus: inputs.ValidationStatus || 'Validated',
                            CreatedAt: new Date().toISOString()
                        };
                        facts.push(newFact);
                        return { recordset: [{ FactId: newFact.FactId }] };
                    }

                    // 5. Query FinancialFacts (Conflict Detection or getFinancialFacts)
                    if (trimmed.startsWith('SELECT') && trimmed.includes('FROM dbo.FinancialFacts')) {
                        // Check if targeted to specific document
                        if (trimmed.includes('f.DocumentId = @DocumentId') && inputs.DocumentId) {
                            const docFacts = facts.filter(f => f.DocumentId === inputs.DocumentId);
                            return { recordset: docFacts };
                        }

                        // Conflict detection query: return facts joined with document info
                        let matched = facts.map(f => {
                            const d = documents.find(doc => doc.DocumentId === f.DocumentId) || {};
                            return {
                                ...f,
                                SourceFileName: d.FileName || f.SourceFileName,
                                CreatedByName: d.CreatedByName,
                                CreatedByEmail: d.CreatedByEmail,
                                ModifiedByName: d.ModifiedByName,
                                ModifiedByEmail: d.ModifiedByEmail,
                                IngestionStatus: d.IngestionStatus,
                                AuthorityType: f.AuthorityRank === 1 ? 'Audited Financials' : (f.AuthorityRank === 2 ? 'Board Packs / Final' : 'Drafts / Working Files')
                            };
                        });
                        return { recordset: matched };
                    }

                    // 7. Insert or Update FactConflicts
                    if (trimmed.includes('dbo.FactConflicts')) {
                        if (trimmed.includes('FactId1 = @F1') || trimmed.includes('INSERT INTO dbo.FactConflicts (FactId1, FactId2')) {
                            const existing = conflicts.find(c => 
                                (c.FactId1 === inputs.F1 && c.FactId2 === inputs.F2) ||
                                (c.FactId1 === inputs.F2 && c.FactId2 === inputs.F1)
                            );
                            if (existing) {
                                existing.ResolutionStatus = inputs.Status;
                                existing.ResolutionNotes = inputs.Notes;
                                existing.ProposedResolution = inputs.Proposed;
                            } else {
                                conflicts.push({
                                    ConflictId: nextConflictId++,
                                    FactId1: inputs.F1,
                                    FactId2: inputs.F2,
                                    ConflictReason: inputs.Reason,
                                    ResolutionStatus: inputs.Status,
                                    ResolutionNotes: inputs.Notes,
                                    ProposedResolution: inputs.Proposed,
                                    CreatedAt: new Date().toISOString()
                                });
                            }
                            return { rowsAffected: [1] };
                        }

                        // Query FactConflicts
                        if (trimmed.startsWith('SELECT ConflictId, FactId1, FactId2')) {
                            return { recordset: [...conflicts] };
                        }

                        // Update FactConflicts resolution
                        if (trimmed.includes('UPDATE dbo.FactConflicts') && trimmed.includes('ResolutionStatus = @ResolutionStatus')) {
                            const docFacts = facts.filter(f => f.DocumentId === inputs.DocId).map(f => f.FactId);
                            conflicts.forEach(c => {
                                if (docFacts.includes(c.FactId1) || docFacts.includes(c.FactId2)) {
                                    c.ResolutionStatus = inputs.ResolutionStatus;
                                    c.ReviewedByEmail = inputs.ReviewerEmail;
                                    c.ResolutionNotes = inputs.ResolutionNotes;
                                    c.ReviewedAt = new Date().toISOString();
                                }
                            });
                            return { rowsAffected: [1] };
                        }
                    }

                    // 8. FinancialFacts update for resolution
                    if (trimmed.includes('UPDATE dbo.FinancialFacts')) {
                        const docId = inputs.DocId;
                        if (trimmed.includes("ValidationStatus = 'Validated'")) {
                            facts.filter(f => f.DocumentId === docId).forEach(f => f.ValidationStatus = 'Validated');
                            // Supersede opposing facts
                            const opposingFactIds = [];
                            conflicts.forEach(c => {
                                const f1 = facts.find(f => f.FactId === c.FactId1);
                                const f2 = facts.find(f => f.FactId === c.FactId2);
                                if (f1 && f1.DocumentId === docId && f2) opposingFactIds.push(f2.FactId);
                                if (f2 && f2.DocumentId === docId && f1) opposingFactIds.push(f1.FactId);
                            });
                            facts.filter(f => opposingFactIds.includes(f.FactId)).forEach(f => f.ValidationStatus = 'Superseded');
                        } else if (trimmed.includes("ValidationStatus = 'Rejected'")) {
                            if (trimmed.includes('UNION')) {
                                // KEEP_EXISTING: only reject conflicting facts of docId
                                const conflictingFactIds = [];
                                conflicts.forEach(c => {
                                    conflictingFactIds.push(c.FactId1, c.FactId2);
                                });
                                facts.filter(f => f.DocumentId === docId && conflictingFactIds.includes(f.FactId)).forEach(f => f.ValidationStatus = 'Rejected');
                            } else {
                                // REJECT all facts of docId
                                facts.filter(f => f.DocumentId === docId).forEach(f => f.ValidationStatus = 'Rejected');
                            }
                        }

                        const targetDoc = documents.find(d => d.DocumentId === docId);
                        if (targetDoc) {
                            if (trimmed.includes("IngestionStatus = 'Rejected'")) {
                                targetDoc.IngestionStatus = 'Rejected';
                            } else {
                                targetDoc.IngestionStatus = 'Succeeded';
                            }
                            targetDoc.LastProcessedAt = new Date().toISOString();
                        }
                        return { rowsAffected: [1] };
                    }

                    // 9. Query FinancialFacts for document
                    if (trimmed.includes('FROM dbo.FinancialFacts') && trimmed.includes('WHERE DocumentId = @DocId')) {
                        const docFacts = facts.filter(f => f.DocumentId === inputs.DocId);
                        return { recordset: docFacts };
                    }

                    // 10. AuditLogs
                    if (trimmed.includes('INSERT INTO dbo.AuditLogs')) {
                        const newAudit = {
                            AuditId: nextAuditId++,
                            EventType: inputs.EventType,
                            DocumentId: inputs.DocumentId,
                            ConflictId: inputs.ConflictId,
                            ActionBy: inputs.ActionBy,
                            ActionRole: inputs.ActionRole,
                            PreviousStatus: inputs.PreviousStatus,
                            NewStatus: inputs.NewStatus,
                            Details: inputs.Details,
                            CorrelationId: inputs.CorrelationId,
                            Timestamp: new Date().toISOString()
                        };
                        auditLogs.push(newAudit);
                        return { rowsAffected: [1] };
                    }
                    if (trimmed.includes('FROM dbo.AuditLogs') && trimmed.includes('@DocumentId')) {
                        const logs = auditLogs.filter(a => a.DocumentId === inputs.DocumentId);
                        return { recordset: [...logs].reverse() };
                    }

                    if (trimmed.includes('SourceAuthorityRanks') || trimmed.includes('IngestionRuns')) {
                        return { recordset: [{ RunId: 1 }] };
                    }

                    return { recordset: [] };
                }
            };
            return req;
        }
    };

    return mockPool;
}

describe('End-to-End Conflict Resolution Flow', () => {
    let mockPool;

    beforeEach(() => {
        mockPool = createMockSqlDb();
        setPool(mockPool);
    });

    afterEach(() => {
        resetPool();
    });

    it('executes full conflict lifecycle: detection, notification, holding, and ACCEPT_NEW resolution', async () => {
        // =========================================================================
        // STEP 1: Seed Document 1 (Existing Baseline File, e.g. Contoso_v1.pdf)
        // =========================================================================
        const doc1Id = await createDocument(
            'Contoso_Logistics_Management_Pack_v1.pdf',
            'SharePoint',
            2, // Rank 2: Board Packs
            null,
            {
                modifiedByName: 'John Doe',
                modifiedByEmail: 'john.doe@contoso.com'
            }
        );
        await updateDocumentStatus(doc1Id, 'Succeeded');

        await insertFinancialFacts(doc1Id, [
            {
                metric: 'Revenue',
                entity: 'Contoso Logistics LLC',
                periodLabel: 'Q2 2026',
                numericValue: 9105000,
                unit: 'AED',
                currency: 'AED',
                sourceLocation: 'Page 3, Row 1',
                authorityRank: 2
            },
            {
                metric: 'Direct Costs',
                entity: 'Contoso Logistics LLC',
                periodLabel: 'Q2 2026',
                numericValue: -6410000,
                unit: 'AED',
                currency: 'AED',
                sourceLocation: 'Page 3, Row 2',
                authorityRank: 2
            }
        ], 2, 'Contoso_Logistics_Management_Pack_v1.pdf');

        // =========================================================================
        // STEP 2: Ingest Document 2 (New Upload with Conflicting Numbers, e.g. Contoso_v2.pdf)
        // =========================================================================
        const doc2Id = await createDocument(
            'Contoso_Logistics_Management_Pack_v2.pdf',
            'SharePoint',
            1, // Rank 1: Audited Financials
            null,
            {
                modifiedByName: 'Sarah Jenkins',
                modifiedByEmail: 'sarah.jenkins@contoso.com'
            }
        );

        await insertFinancialFacts(doc2Id, [
            {
                metric: 'Revenue',
                entity: 'Contoso Logistics LLC',
                periodLabel: 'Q2 2026',
                numericValue: 9350000, // Discrepancy: +245,000 AED
                unit: 'AED',
                currency: 'AED',
                sourceLocation: 'Page 4, Table 1',
                authorityRank: 1
            },
            {
                metric: 'Direct Costs',
                entity: 'Contoso Logistics LLC',
                periodLabel: 'Q2 2026',
                numericValue: -6591800, // Discrepancy: -181,800 AED
                unit: 'AED',
                currency: 'AED',
                sourceLocation: 'Page 4, Table 1',
                authorityRank: 1
            }
        ], 1, 'Contoso_Logistics_Management_Pack_v2.pdf');

        // =========================================================================
        // STEP 3: Detect Conflicts (Rule: Zero Auto-Resolution)
        // =========================================================================
        const conflicts = await detectAndResolveConflicts(doc2Id);

        // Verification 1: Exactly 2 conflicts detected
        assert.strictEqual(conflicts.length, 2, 'Should detect exactly 2 conflicting metrics (Revenue and Direct Costs)');

        // Verification 2: Status is Pending Review (NEVER auto-resolved based on Rank 1 > Rank 2)
        assert.strictEqual(conflicts[0].status, 'Pending Review');
        assert.strictEqual(conflicts[1].status, 'Pending Review');

        // Verification 3: Narrative contains required wording with existing uploader and document name
        const revConflict = conflicts.find(c => c.metric === 'Revenue');
        assert.ok(revConflict, 'Revenue conflict must exist');
        assert.strictEqual(revConflict.existingValue, 9105000);
        assert.strictEqual(revConflict.uploadedValue, 9350000);
        assert.strictEqual(revConflict.difference, 245000);
        assert.ok(
            revConflict.notes.includes('FinChat already has a document uploaded by John Doe with document name "Contoso_Logistics_Management_Pack_v1.pdf" which has conflicts with your uploaded document "Contoso_Logistics_Management_Pack_v2.pdf" on metric "Revenue": 9105000 AED vs 9350000 AED (Difference: +245000).'),
            'Conflict notes must strictly adhere to the required narrative format'
        );

        // Move Document 2 to Pending Review in SQL
        await updateDocumentStatus(doc2Id, 'Pending Review');

        // =========================================================================
        // STEP 4: SharePoint Queue Item Status Update Simulation
        // =========================================================================
        // Simulate updating SharePoint queue item: status becomes 'Pending Review', ConflictDetected becomes true
        const mockGraphClient = {
            patchedPayload: null,
            api: (endpoint) => ({
                patch: async (payload) => {
                    mockGraphClient.patchedPayload = payload;
                    return { success: true };
                }
            })
        };

        await updateQueueItemStatus(
            mockGraphClient,
            'site-123',
            'list-456',
            'item-789',
            'Pending Review',
            'Financial discrepancies detected requiring review.',
            true
        );

        assert.strictEqual(mockGraphClient.patchedPayload.ProcessingStatus, 'Pending Review');
        assert.strictEqual(mockGraphClient.patchedPayload.ConflictDetected, true, 'SharePoint ConflictDetected column must be true');

        // =========================================================================
        // STEP 5: Notification Email & HMAC Resolution Token Generation
        // =========================================================================
        const emailResult = await sendConflictNotificationEmail({
            documentId: doc2Id,
            fileName: 'Contoso_Logistics_Management_Pack_v2.pdf',
            modifiedByEmail: 'sarah.jenkins@contoso.com',
            modifiedByName: 'Sarah Jenkins',
            conflicts,
            baseUrl: 'https://finchat.azurewebsites.net',
            correlationId: 'corr-test-flow-1'
        });

        assert.strictEqual(emailResult.success, true);
        assert.strictEqual(emailResult.recipient, 'sarah.jenkins@contoso.com');
        assert.ok(emailResult.acceptLink.includes('action=ACCEPT_NEW'));
        assert.ok(emailResult.keepLink.includes('action=KEEP_EXISTING'));

        // Extract token from accept link
        const acceptTokenMatch = emailResult.acceptLink.match(/token=([^&]+)/);
        assert.ok(acceptTokenMatch && acceptTokenMatch[1], 'Must produce a valid token parameter in accept link');
        const acceptToken = acceptTokenMatch[1];

        // Verify token validity
        const tokenCheck = verifyConflictResolutionToken(acceptToken);
        assert.strictEqual(tokenCheck.valid, true);
        assert.strictEqual(tokenCheck.payload.documentId, doc2Id);
        assert.strictEqual(tokenCheck.payload.userEmail, 'sarah.jenkins@contoso.com');
        assert.strictEqual(tokenCheck.payload.action, 'ACCEPT_NEW');

        // =========================================================================
        // STEP 6: Chat Governance (Querying Document in 'Pending Review' Status)
        // =========================================================================
        const mockChatContext = {
            log: () => {},
            warn: () => {},
            error: () => {}
        };
        const mockChatReq = {
            url: 'http://localhost:7071/api/chat',
            headers: new Map(),
            json: async () => ({
                question: 'What is the Revenue for Q2 2026?',
                documentId: doc2Id
            })
        };

        const chatResponse = await chatHandler(mockChatReq, mockChatContext);
        assert.strictEqual(chatResponse.status, 200);
        const chatBody = JSON.parse(chatResponse.body);
        assert.strictEqual(chatBody.status, 'PENDING_REVIEW', 'Chat must refuse and return PENDING_REVIEW while document has unresolved conflicts');
        assert.ok(chatBody.answer.includes('pending user review/confirmation'));

        // =========================================================================
        // STEP 7: Resolve Conflict via HTTP (Scenario: Reviewer clicks ACCEPT_NEW)
        // =========================================================================
        const mockResolveContext = {
            log: () => {},
            warn: () => {},
            error: () => {}
        };

        // Sub-test 7A: Tampered token must fail with 400
        const tamperedReq = {
            method: 'GET',
            query: new Map([
                ['token', acceptToken.slice(0, -6) + 'xxxxxx'],
                ['action', 'ACCEPT_NEW']
            ])
        };
        const tamperedRes = await resolveConflictHandler(tamperedReq, mockResolveContext);
        assert.strictEqual(tamperedRes.status, 400);
        assert.ok(tamperedRes.body.includes('Resolution Request Failed'));

        // Sub-test 7B: Valid token with action=ACCEPT_NEW succeeds
        const validReq = {
            method: 'GET',
            query: new Map([
                ['token', acceptToken],
                ['action', 'ACCEPT_NEW']
            ])
        };
        const resolveRes = await resolveConflictHandler(validReq, mockResolveContext);
        assert.strictEqual(resolveRes.status, 200);
        assert.strictEqual(resolveRes.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.ok(resolveRes.body.includes('Conflict Resolved Successfully'));
        assert.ok(resolveRes.body.includes('New Version Accepted (Previous Superseded)'));

        // =========================================================================
        // STEP 8: Verify Final Database Governance State
        // =========================================================================
        // 1. Document 2 status is now Succeeded
        const updatedDoc2 = await getDocumentById(doc2Id);
        assert.strictEqual(updatedDoc2.IngestionStatus, 'Succeeded');

        // 2. FactConflicts status is updated to 'Resolved (Accepted New)'
        const storedConflicts = mockPool.data.conflicts;
        assert.ok(storedConflicts.length > 0);
        assert.strictEqual(storedConflicts[0].ResolutionStatus, 'Resolved (Accepted New)');
        assert.strictEqual(storedConflicts[0].ReviewedByEmail, 'sarah.jenkins@contoso.com');
        assert.ok(storedConflicts[0].ReviewedAt);

        // 3. Document 2's facts are Validated
        const doc2Facts = await getFinancialFacts(doc2Id);
        assert.ok(doc2Facts.every(f => f.ValidationStatus === 'Validated'), 'Document 2 facts must be marked Validated');

        // 4. Document 1's conflicting facts are marked Superseded
        const doc1Facts = await getFinancialFacts(doc1Id);
        assert.ok(doc1Facts.every(f => f.ValidationStatus === 'Superseded'), 'Document 1 conflicting facts must be marked Superseded');

        // 5. Audit Log records CONFLICT_RESOLVED
        const auditLogs = await getAuditLogsForDocument(doc2Id);
        const resolvedAudit = auditLogs.find(a => a.EventType === 'CONFLICT_RESOLVED');
        assert.ok(resolvedAudit, 'AuditLogs must have CONFLICT_RESOLVED event');
        assert.strictEqual(resolvedAudit.ActionBy, 'sarah.jenkins@contoso.com');
        assert.strictEqual(resolvedAudit.NewStatus, 'Succeeded');
    });

    it('handles alternative resolution: KEEP_EXISTING (keeps baseline, marks new figures rejected)', async () => {
        // Seed Doc 1
        const doc1Id = await createDocument('Doc1.pdf', 'SharePoint', 2, null, { modifiedByEmail: 'u1@contoso.com' });
        await updateDocumentStatus(doc1Id, 'Succeeded');
        await insertFinancialFacts(doc1Id, [{ metric: 'Net Income', periodLabel: '2025', numericValue: 500000 }], 2, 'Doc1.pdf');

        // Seed Doc 2 (Conflicting)
        const doc2Id = await createDocument('Doc2.pdf', 'SharePoint', 1, null, { modifiedByEmail: 'u2@contoso.com' });
        await updateDocumentStatus(doc2Id, 'Pending Review');
        await insertFinancialFacts(doc2Id, [{ metric: 'Net Income', periodLabel: '2025', numericValue: 550000 }], 1, 'Doc2.pdf');

        // Detect conflicts
        await detectAndResolveConflicts(doc2Id);

        // Generate resolution token for KEEP_EXISTING
        const keepToken = generateConflictResolutionToken({
            documentId: doc2Id,
            userEmail: 'u2@contoso.com',
            action: 'KEEP_EXISTING'
        });

        // Reviewer executes KEEP_EXISTING via API POST
        const req = {
            method: 'POST',
            query: new Map(),
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
                token: keepToken,
                action: 'KEEP_EXISTING',
                reviewerEmail: 'governance.lead@contoso.com',
                notes: 'Retaining baseline statutory figure.'
            })
        };

        const res = await resolveConflictHandler(req, { log: () => {}, warn: () => {}, error: () => {} });
        assert.strictEqual(res.status, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.resolution.status, 'Succeeded');

        // Verification: Doc 1 fact remains Validated
        const doc1Facts = await getFinancialFacts(doc1Id);
        assert.strictEqual(doc1Facts[0].ValidationStatus, 'Validated');

        // Verification: Doc 2 conflicting fact is Rejected
        const doc2Facts = await getFinancialFacts(doc2Id);
        assert.strictEqual(doc2Facts[0].ValidationStatus, 'Rejected');

        // Verification: Conflict status in SQL is 'Resolved (Kept Existing)'
        const conflicts = mockPool.data.conflicts;
        assert.strictEqual(conflicts[0].ResolutionStatus, 'Resolved (Kept Existing)');
    });

    it('handles REJECT action: marks document and facts as Rejected', async () => {
        const docId = await createDocument('DocBad.pdf', 'SharePoint', 4, null, { modifiedByEmail: 'bad@contoso.com' });
        await updateDocumentStatus(docId, 'Pending Review');
        await insertFinancialFacts(docId, [{ metric: 'EBITDA', periodLabel: '2025', numericValue: 120000 }], 4, 'DocBad.pdf');

        const token = generateConflictResolutionToken({
            documentId: docId,
            userEmail: 'bad@contoso.com',
            action: 'REJECT'
        });

        const req = {
            method: 'POST',
            query: new Map(),
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
                token,
                action: 'REJECT',
                reviewerEmail: 'auditor@contoso.com',
                notes: 'Fraudulent or unverified numbers.'
            })
        };

        const res = await resolveConflictHandler(req, { log: () => {}, warn: () => {}, error: () => {} });
        assert.strictEqual(res.status, 200);

        const doc = await getDocumentById(docId);
        assert.strictEqual(doc.IngestionStatus, 'Rejected');

        const facts = await getFinancialFacts(docId);
        assert.strictEqual(facts[0].ValidationStatus, 'Rejected');
    });
});
