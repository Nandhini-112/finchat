const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateConflictResolutionToken,
    verifyConflictResolutionToken
} = require('../src/services/conflict-token');
const {
    buildConflictEmailHtml,
    buildConflictEmailText,
    sendConflictNotificationEmail
} = require('../src/services/notification');

describe('Conflict Governance & Email Resolution Tests', () => {

    describe('HMAC Token Service (conflict-token.js)', () => {
        it('generates a valid, signed resolution token and decodes payload accurately', () => {
            const token = generateConflictResolutionToken({
                documentId: 42,
                userEmail: 'finance.lead@contoso.com',
                action: 'ACCEPT_NEW',
                expiresInDays: 7
            });

            assert.ok(token, 'Token must not be empty');
            assert.ok(token.includes('.'), 'Token must be composed of payload.signature');

            const verification = verifyConflictResolutionToken(token);
            assert.strictEqual(verification.valid, true);
            assert.strictEqual(verification.payload.documentId, 42);
            assert.strictEqual(verification.payload.userEmail, 'finance.lead@contoso.com');
            assert.strictEqual(verification.payload.action, 'ACCEPT_NEW');
            assert.ok(verification.payload.expiresAt > verification.payload.issuedAt);
        });

        it('detects and rejects a tampered token signature', () => {
            const token = generateConflictResolutionToken({
                documentId: 42,
                userEmail: 'finance.lead@contoso.com'
            });

            // Tamper with the token signature
            const tampered = token.slice(0, -4) + 'abcd';
            const verification = verifyConflictResolutionToken(tampered);

            assert.strictEqual(verification.valid, false);
            assert.ok(verification.error.includes('signature'), 'Should report signature mismatch');
        });

        it('rejects expired tokens', () => {
            // Generate token with negative duration (already expired)
            const expiredToken = generateConflictResolutionToken({
                documentId: 10,
                userEmail: 'auditor@contoso.com',
                expiresInDays: -1
            });

            const verification = verifyConflictResolutionToken(expiredToken);
            assert.strictEqual(verification.valid, false);
            assert.ok(verification.error.includes('expired'), 'Should report token expired');
        });
    });

    describe('Email Notification Formatting & Narrative (notification.js)', () => {
        const sampleConflicts = [
            {
                metric: 'Revenue',
                period: 'Q2 2026',
                entity: 'Contoso Logistics LLC',
                currency: 'AED',
                existingValue: 9105000,
                uploadedValue: 9350000,
                difference: 245000,
                existingFileName: 'Contoso_Logistics_Management_Pack_v1.pdf',
                existingUploader: 'John Doe (Audited Financials)'
            },
            {
                metric: 'Direct Costs',
                period: 'Q2 2026',
                entity: 'Contoso Logistics LLC',
                currency: 'AED',
                existingValue: -6410000,
                uploadedValue: -6591800,
                difference: -181800,
                existingFileName: 'Contoso_Logistics_Management_Pack_v1.pdf',
                existingUploader: 'John Doe (Audited Financials)'
            }
        ];

        it('builds HTML email containing exact required wording, table, and buttons', () => {
            const html = buildConflictEmailHtml({
                fileName: 'Contoso_Logistics_Management_Pack_v2.pdf',
                documentId: 14,
                modifiedByName: 'Sarah Jenkins',
                conflicts: sampleConflicts,
                acceptLink: 'https://finchat.azurewebsites.net/api/resolveConflict?token=acc123&action=ACCEPT_NEW',
                keepLink: 'https://finchat.azurewebsites.net/api/resolveConflict?token=keep123&action=KEEP_EXISTING'
            });

            // Verify the specific prompt statement
            assert.ok(
                html.includes('FinChat already has a document uploaded by John Doe (Audited Financials) with document name &quot;Contoso_Logistics_Management_Pack_v1.pdf&quot; which has conflicts with your uploaded document.') ||
                html.includes('FinChat already has a document uploaded by John Doe (Audited Financials) with document name "Contoso_Logistics_Management_Pack_v1.pdf" which has conflicts with your uploaded document.'),
                'HTML must contain the exact provenance notification text'
            );

            // Verify table figures
            assert.ok(html.includes('Revenue'), 'Must contain Revenue metric');
            assert.ok(html.includes('9105000 AED'), 'Must contain existing value');
            assert.ok(html.includes('9350000 AED'), 'Must contain uploaded value');
            assert.ok(html.includes('+245000 AED'), 'Must contain variance');

            // Verify action links
            assert.ok(html.includes('https://finchat.azurewebsites.net/api/resolveConflict?token=acc123&action=ACCEPT_NEW'), 'Must have Accept link');
            assert.ok(html.includes('https://finchat.azurewebsites.net/api/resolveConflict?token=keep123&action=KEEP_EXISTING'), 'Must have Keep link');
            assert.ok(html.includes('Accept New Version'), 'Must have Accept button text');
            assert.ok(html.includes('Keep Existing Figures'), 'Must have Keep button text');
        });

        it('builds plaintext email matching structure', () => {
            const text = buildConflictEmailText({
                fileName: 'Contoso_Logistics_Management_Pack_v2.pdf',
                documentId: 14,
                conflicts: sampleConflicts,
                acceptLink: 'http://localhost:7071/api/resolveConflict?token=acc&action=ACCEPT_NEW',
                keepLink: 'http://localhost:7071/api/resolveConflict?token=keep&action=KEEP_EXISTING'
            });

            assert.ok(text.includes('FinChat already has a document uploaded by John Doe (Audited Financials) with document name "Contoso_Logistics_Management_Pack_v1.pdf" which has conflicts with your uploaded document.'));
            assert.ok(text.includes('Revenue (Q2 2026): Existing = 9105000 vs Uploaded = 9350000'));
            assert.ok(text.includes('http://localhost:7071/api/resolveConflict?token=acc&action=ACCEPT_NEW'));
            assert.ok(text.includes('http://localhost:7071/api/resolveConflict?token=keep&action=KEEP_EXISTING'));
        });

        it('sendConflictNotificationEmail creates action tokens and returns delivery info in mock mode', async () => {
            const logs = [];
            const mockContext = {
                log: (msg) => logs.push(msg)
            };

            const result = await sendConflictNotificationEmail({
                documentId: 14,
                fileName: 'Contoso_v2.pdf',
                modifiedByEmail: 'sarah.j@contoso.com',
                modifiedByName: 'Sarah Jenkins',
                conflicts: sampleConflicts,
                baseUrl: 'http://localhost:7071',
                correlationId: 'test-corr-1',
                context: mockContext
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.recipient, 'sarah.j@contoso.com');
            assert.ok(result.acceptLink.includes('/api/resolveConflict?token='));
            assert.ok(result.acceptLink.includes('action=ACCEPT_NEW'));
            assert.ok(result.keepLink.includes('action=KEEP_EXISTING'));

            // Verify the generated token can be verified
            const tokenMatch = result.acceptLink.match(/token=([^&]+)/);
            assert.ok(tokenMatch && tokenMatch[1]);
            const verified = verifyConflictResolutionToken(tokenMatch[1]);
            assert.strictEqual(verified.valid, true);
            assert.strictEqual(verified.payload.documentId, 14);
            assert.strictEqual(verified.payload.userEmail, 'sarah.j@contoso.com');
            assert.strictEqual(verified.payload.action, 'ACCEPT_NEW');
        });
    });
});

