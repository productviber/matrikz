/**
 * Governance Token Utilities
 *
 * Provides token verification and validation for signed governance decisions.
 * Tokens are HS256-signed JWTs issued by governance-worker.
 *
 * Verification steps:
 *   1. Parse JWT structure (header.payload.signature)
 *   2. Verify HMAC signature using governance worker's public key
 *   3. Check token expiration (expiresAt field in payload)
 *   4. Return verified payload or error reason
 */

export type TokenVerificationReason =
    | 'token_malformed'
    | 'token_invalid_signature'
    | 'token_expired'
    | 'token_verified';

export interface TokenVerificationResult {
    valid: boolean;
    reason: TokenVerificationReason;
    payload?: {
        decisionId: string;
        actorTenantId: string | null;
        targetTenantId: string | null;
        actionType: string;
        allowed: boolean;
        policyVersion: string | null;
        issuedAt: string;
        expiresAt: string;
        jti: string;
    };
}

function toBase64Url(text: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(base64Url: string): string {
    const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
    const keyBytes = new TextEncoder().encode(secret);
    return crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
    );
}

async function hmacVerify(
    secret: string,
    signingInput: string,
    signature: string,
): Promise<boolean> {
    const key = await importHmacKey(secret);
    const bytes = new TextEncoder().encode(signingInput);

    // Decode the signature from base64url
    const sigBinary = fromBase64Url(signature);
    const sigBytes = Uint8Array.from(sigBinary, (ch) => ch.charCodeAt(0));

    try {
        return await crypto.subtle.verify('HMAC', key, sigBytes, bytes);
    } catch {
        return false;
    }
}

/**
 * Verify a signed governance decision token.
 *
 * @param token JWT token string (header.payload.signature)
 * @param signingKey HMAC signing key from governance-worker configuration
 * @returns Verification result with payload if valid
 */
export async function verifyGovernanceToken(
    token: string | null | undefined,
    signingKey: string | null | undefined,
): Promise<TokenVerificationResult> {
    // Missing token or key
    if (!token) {
        return { valid: false, reason: 'token_malformed' };
    }

    if (!signingKey) {
        // No key configured — can't verify, treat as unable to validate
        // In enforce mode, this should fail-safe (block); in observe mode, allow
        return { valid: false, reason: 'token_malformed' };
    }

    // Parse JWT structure
    const parts = token.split('.');
    if (parts.length !== 3) {
        return { valid: false, reason: 'token_malformed' };
    }

    const [encodedHeader, encodedPayload, signature] = parts;

    // Verify signature
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signatureValid = await hmacVerify(signingKey, signingInput, signature);

    if (!signatureValid) {
        return { valid: false, reason: 'token_invalid_signature' };
    }

    // Decode and validate payload
    let payload: unknown;
    try {
        const decodedPayload = fromBase64Url(encodedPayload);
        payload = JSON.parse(decodedPayload);
    } catch {
        return { valid: false, reason: 'token_malformed' };
    }

    if (typeof payload !== 'object' || payload === null) {
        return { valid: false, reason: 'token_malformed' };
    }

    const payloadObj = payload as Record<string, unknown>;

    // Check expiration
    if (payloadObj.expiresAt) {
        const expiresAtTime = new Date(payloadObj.expiresAt as string).getTime();
        if (Date.now() > expiresAtTime) {
            return { valid: false, reason: 'token_expired' };
        }
    }

    // Validate required fields
    if (
        typeof payloadObj.decisionId !== 'string' ||
        typeof payloadObj.actionType !== 'string' ||
        typeof payloadObj.allowed !== 'boolean' ||
        typeof payloadObj.issuedAt !== 'string' ||
        typeof payloadObj.expiresAt !== 'string' ||
        typeof payloadObj.jti !== 'string'
    ) {
        return { valid: false, reason: 'token_malformed' };
    }

    return {
        valid: true,
        reason: 'token_verified',
        payload: {
            decisionId: payloadObj.decisionId as string,
            actorTenantId: (payloadObj.actorTenantId as string | null) ?? null,
            targetTenantId: (payloadObj.targetTenantId as string | null) ?? null,
            actionType: payloadObj.actionType as string,
            allowed: payloadObj.allowed as boolean,
            policyVersion: (payloadObj.policyVersion as string | null) ?? null,
            issuedAt: payloadObj.issuedAt as string,
            expiresAt: payloadObj.expiresAt as string,
            jti: payloadObj.jti as string,
        },
    };
}

/**
 * Check if a policy version is fresh (within acceptable skew).
 *
 * @param receivedPolicyVersion Policy version from governance decision
 * @param localPolicyVersion Current known policy version
 * @param allowedSkew Maximum number of versions behind to accept (default: 0 = must match exactly)
 * @returns true if version is acceptable, false if stale
 */
export function isPolicyVersionFresh(
    receivedPolicyVersion: string | null,
    localPolicyVersion: string | null,
    allowedSkew: number = 0,
): boolean {
    // If either is null, consider it fresh (no validation possible)
    if (!receivedPolicyVersion || !localPolicyVersion) {
        return true;
    }

    // Parse versions as integers (format: "v123" or "123")
    const receivedNum = parseInt(receivedPolicyVersion.replace(/\D/g, ''), 10);
    const localNum = parseInt(localPolicyVersion.replace(/\D/g, ''), 10);

    if (Number.isNaN(receivedNum) || Number.isNaN(localNum)) {
        // Can't parse — treat as fresh
        return true;
    }

    // Check if received version is not too far behind
    return receivedNum >= localNum - allowedSkew;
}
