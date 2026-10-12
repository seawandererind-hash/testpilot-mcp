import { createHash, randomBytes } from 'node:crypto';

import type { ProjectStore } from './store.js';

const TTL_MS = 30 * 60 * 1000;

/** Stable digest of whatever a preview showed, so an apply can prove nothing changed since. */
export function digestOf(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * A preview call registers a pending confirmation in state.json and returns its token.
 * The matching apply call must present the same token and digest. Because the
 * token lives in the repository, this works across processes and protocol eras.
 */
export function issueConfirmation(store: ProjectStore, action: string, digest: string): string {
    const token = `${action}-${randomBytes(6).toString('hex')}`;
    const created = new Date();
    store.updateState(state => {
        state.pending[action] = { token, action, digest, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + TTL_MS).toISOString() };
    });
    return token;
}

export type ConfirmationCheck = { ok: true } | { ok: false; reason: string };

export function verifyConfirmation(store: ProjectStore, action: string, token: string | undefined, digest: string): ConfirmationCheck {
    const pending = store.readState().pending[action];
    if (!token) return { ok: false, reason: `Run the preview for "${action}" first, show it to the user, and pass its confirmToken after they approve.` };
    if (!pending || pending.token !== token) return { ok: false, reason: 'That confirmToken is unknown or was already used. Run the preview again.' };
    if (Date.parse(pending.expiresAt) < Date.now()) return { ok: false, reason: 'That confirmToken has expired (30 minutes). Run the preview again.' };
    if (pending.digest !== digest) return { ok: false, reason: 'The planned changes differ from what the preview showed. Run the preview again and show the user the new version.' };
    return { ok: true };
}

export function consumeConfirmation(store: ProjectStore, action: string): void {
    store.updateState(state => {
        delete state.pending[action];
    });
}
