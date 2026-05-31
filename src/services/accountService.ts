import { invoke } from '@tauri-apps/api/core';

/**
 * Multi-account registry (frontend wrapper). Mirrors the Rust `StoredAccount`
 * in `services/account_store.rs`. The primary is the account you watch / stream
 * as; secondaries are "action" accounts (chat send, and later mining / mod).
 */
export interface StoredAccount {
  user_id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  is_primary: boolean;
  added_at: number;
}

/** Every linked account, primary first. */
export function listAccounts(): Promise<StoredAccount[]> {
  return invoke<StoredAccount[]>('list_twitch_accounts');
}

/** Number of linked accounts. The send-as picker shows only when this is >= 2. */
export function getAccountCount(): Promise<number> {
  return invoke<number>('get_twitch_account_count');
}

/**
 * Link a new secondary account. Opens the system browser to Twitch's forced
 * account chooser; resolves with the linked account once sign-in completes, or
 * rejects with a message (cancelled, timed out, or "already your primary").
 * Never touches the primary's cached token.
 */
export function addAccount(): Promise<StoredAccount> {
  return invoke<StoredAccount>('add_twitch_account');
}

/** Unlink a secondary account by Twitch user id. The primary cannot be removed. */
export function removeAccount(userId: string): Promise<void> {
  return invoke('remove_twitch_account', { userId });
}

/**
 * Make a linked account the main (the one you watch and stream as). Moves its
 * token into the primary slot and demotes the previous main to a linked account
 * (kept, never deleted). Resolves with the newly-active account.
 */
export function setActiveAccount(userId: string): Promise<StoredAccount> {
  return invoke<StoredAccount>('set_active_twitch_account', { userId });
}

/**
 * Sign out of the current main. Resolves with the account that was promoted to
 * main in its place, or `null` if that was the last account (a full sign-out).
 */
export function signOutActiveAccount(): Promise<StoredAccount | null> {
  return invoke<StoredAccount | null>('sign_out_active_twitch_account');
}

// ── Per-account 7TV (for editing a linked account's cosmetics) ───────────────

export interface SevenTVAccountStatus {
  is_authenticated: boolean;
  user_id: string | null; // the account's 7TV user id
  twitch_id: string | null;
}

/** 7TV connection status for a linked account (by Twitch user id). */
export function getSeventvStatusForAccount(accountId: string): Promise<SevenTVAccountStatus> {
  return invoke<SevenTVAccountStatus>('get_seventv_auth_status_for', { accountId });
}

/**
 * Connect a linked account's 7TV via an isolated (incognito) login window, so
 * you can sign into Twitch as that account without disturbing your main. Resolves
 * when the window opens; the capture fires a `seventv-connected-account` event
 * (payload = the account id) when the token lands.
 */
export function connectSeventvForAccount(accountId: string): Promise<boolean> {
  return invoke<boolean>('open_seventv_login_window_for_account', { accountId });
}

/** Disconnect a linked account's 7TV. */
export function disconnectSeventvForAccount(accountId: string): Promise<boolean> {
  return invoke<boolean>('logout_seventv_for', { accountId });
}

/**
 * Authoritatively verify an account's 7TV token with 7TV (network check, unlike
 * the instant local status). Returns false and clears the token if 7TV rejects
 * it, so a revoked/dead token stops reading as connected.
 */
export function validateSeventvForAccount(accountId: string): Promise<boolean> {
  return invoke<boolean>('validate_seventv_token_for', { accountId });
}

/**
 * Silently refresh an account's 7TV token by reloading its persisted login
 * session in a hidden window (no interaction). Returns true if a fresh token was
 * captured; false if the session lapsed and a visible reconnect is needed.
 */
export function refreshSeventvForAccount(accountId: string): Promise<boolean> {
  return invoke<boolean>('refresh_seventv_token_for_account', { accountId });
}

/** Set a linked account's active 7TV paint (`userId` is its 7TV user id). */
export function setSeventvPaintForAccount(
  accountId: string,
  userId: string,
  paintId: string | null,
): Promise<unknown> {
  return invoke('set_seventv_paint_for', { accountId, userId, paintId });
}

/** Set a linked account's active 7TV badge (`userId` is its 7TV user id). */
export function setSeventvBadgeForAccount(
  accountId: string,
  userId: string,
  badgeId: string | null,
): Promise<unknown> {
  return invoke('set_seventv_badge_for', { accountId, userId, badgeId });
}
