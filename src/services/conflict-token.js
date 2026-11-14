const crypto = require('crypto');
require('../utils/config');

const DEFAULT_SECRET = process.env.CONFLICT_TOKEN_SECRET || process.env.CLIENT_SECRET || 'finchat-default-conflict-secret-key-32ch';
const DEFAULT_EXPIRY_DAYS = 7;

/**
 * Encodes an object to a URL-safe Base64 string.
 */
function base64UrlEncode(str) {
    return Buffer.from(str, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Decodes a URL-safe Base64 string.
 */
function base64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Generates an HMAC SHA-256 signature for a payload.
 */
function createSignature(payloadString, secret = DEFAULT_SECRET) {
    return crypto.createHmac('sha256', secret)
        .update(payloadString)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Generates a secure, signed token for conflict resolution action links.
 *
 * @param {Object} params
 * @param {number|string} params.documentId - The DocumentId in Azure SQL
 * @param {string} [params.userEmail] - Email of the recipient / modified_user
 * @param {string} [params.action] - Optional default action ('ACCEPT_NEW', 'KEEP_EXISTING')
 * @param {number} [params.expiresInDays=7] - Validity duration in days
 * @returns {string} Signed token: `<base64Payload>.<signature>`
 */
function generateConflictResolutionToken({
    documentId,
    userEmail = null,
    action = null,
    expiresInDays = DEFAULT_EXPIRY_DAYS
}) {
    if (!documentId) {
        throw new Error('documentId is required to generate a conflict resolution token.');
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + (expiresInDays * 24 * 60 * 60);

    const payload = {
        docId: Number(documentId) || documentId,
        email: userEmail || null,
        act: action || null,
        iat: issuedAt,
        exp: expiresAt,
        nonce: crypto.randomBytes(6).toString('hex')
    };

    const payloadString = JSON.stringify(payload);
    const encodedPayload = base64UrlEncode(payloadString);
    const signature = createSignature(encodedPayload);

    return `${encodedPayload}.${signature}`;
}

/**
 * Validates a conflict resolution token.
 *
 * @param {string} token - The signed token string
 * @param {string} [secret] - Optional secret override
 * @returns {{ valid: boolean, payload?: Object, error?: string }}
 */
function verifyConflictResolutionToken(token, secret = DEFAULT_SECRET) {
    if (!token || typeof token !== 'string') {
        return { valid: false, error: 'Token is missing or not a string.' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 2) {
        return { valid: false, error: 'Token format is invalid (expected payload.signature).' };
    }

    const [encodedPayload, providedSignature] = parts;
    const expectedSignature = createSignature(encodedPayload, secret);

    // Constant-time signature comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
        return { valid: false, error: 'Invalid token signature (token has been tampered with or expired secret).' };
    }

    try {
        const payloadJson = base64UrlDecode(encodedPayload);
        const payload = JSON.parse(payloadJson);

        const currentSeconds = Math.floor(Date.now() / 1000);
        if (payload.exp && currentSeconds > payload.exp) {
            return {
                valid: false,
                error: `Token expired at ${new Date(payload.exp * 1000).toISOString()}. Please request a fresh link.`
            };
        }

        return {
            valid: true,
            payload: {
                documentId: payload.docId,
                userEmail: payload.email,
                action: payload.act,
                issuedAt: new Date(payload.iat * 1000),
                expiresAt: new Date(payload.exp * 1000)
            }
        };
    } catch (parseErr) {
        return { valid: false, error: `Malformed token payload: ${parseErr.message}` };
    }
}

module.exports = {
    generateConflictResolutionToken,
    verifyConflictResolutionToken
};

