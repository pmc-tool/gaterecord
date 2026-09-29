/**
 * Sign-in through the YAAD account (Keycloak), OIDC authorization code + PKCE
 * (specs/002-account-identity-integration/design.md §4.0, option 1).
 *
 * The password never reaches gaterecord: the browser is sent to Keycloak's
 * hosted login page and comes back to /auth/callback with a one-time code,
 * exchanged here for tokens. The backend already accepts these RS256 tokens
 * (the 'keycloak' passport strategy).
 *
 * Disabled unless VITE_KEYCLOAK_URL, VITE_KEYCLOAK_REALM and
 * VITE_KEYCLOAK_CLIENT_ID are all set, so builds without them keep the local
 * email + password login only.
 */

const KEYCLOAK_URL = (import.meta.env.VITE_KEYCLOAK_URL || '').replace(/\/+$/, '');
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || '';
const KEYCLOAK_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || '';

const CALLBACK_PATH = '/auth/callback';
/** One login round trip; sessionStorage so it never outlives the tab. */
const PENDING_KEY = 'oidcPending';
const ID_TOKEN_KEY = 'idToken';

export interface OidcTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
}

export interface OidcCallbackResult {
  tokens: OidcTokens;
  /** Where to go after the callback (the page that started the round trip). */
  returnTo: string;
  /** Set when the round trip ran a Keycloak action such as UPDATE_PASSWORD. */
  action?: string;
  /** Keycloak's kc_action_status: 'success', 'cancelled' or 'error'. */
  actionStatus?: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  returnTo: string;
  action?: string;
}

function realmUrl(): string {
  return `${KEYCLOAK_URL}/realms/${encodeURIComponent(KEYCLOAK_REALM)}/protocol/openid-connect`;
}

function redirectUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  if (!window.isSecureContext || !crypto.subtle) {
    // crypto.subtle only exists on https:// or localhost.
    throw new Error('Signing in with a YAAD account needs HTTPS (or localhost).');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function tokenRequest(body: Record<string, string>): Promise<OidcTokens> {
  const response = await fetch(`${realmUrl()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: KEYCLOAK_CLIENT_ID, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Sign-in failed');
  }
  if (data.id_token) {
    localStorage.setItem(ID_TOKEN_KEY, data.id_token);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
  };
}

export const oidcService = {
  isEnabled(): boolean {
    return Boolean(KEYCLOAK_URL && KEYCLOAK_REALM && KEYCLOAK_CLIENT_ID);
  },

  /**
   * Redirect to Keycloak. With action 'UPDATE_PASSWORD' the signed-in user is
   * taken straight to Keycloak's change-password screen (an application
   * initiated action) and returned to returnTo afterwards.
   */
  async startLogin(options: { returnTo?: string; action?: string; email?: string } = {}) {
    const verifier = randomString(48);
    const pending: PendingLogin = {
      state: randomString(),
      verifier,
      returnTo: options.returnTo || '/dashboard',
      action: options.action,
    };
    const params = new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid',
      state: pending.state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    });
    if (options.action) {
      params.set('kc_action', options.action);
    }
    if (options.email) {
      params.set('login_hint', options.email);
    }
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    window.location.assign(`${realmUrl()}/auth?${params.toString()}`);
  },

  /** Finish the round trip on /auth/callback: check state, exchange the code. */
  async handleCallback(search: string): Promise<OidcCallbackResult> {
    const params = new URLSearchParams(search);
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    const pending: PendingLogin | null = raw ? JSON.parse(raw) : null;

    const error = params.get('error');
    if (error) {
      throw new Error(params.get('error_description') || error);
    }
    const code = params.get('code');
    if (!pending || !code || params.get('state') !== pending.state) {
      throw new Error('This sign-in link has expired. Please sign in again.');
    }

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    });
    return {
      tokens,
      returnTo: pending.returnTo,
      action: pending.action,
      actionStatus: params.get('kc_action_status') || undefined,
    };
  },

  refresh(refreshToken: string): Promise<OidcTokens> {
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  },

  /** End the Keycloak session too, so the next sign-in asks for a password. */
  logout(returnTo = '/login'): void {
    const idToken = localStorage.getItem(ID_TOKEN_KEY);
    localStorage.removeItem(ID_TOKEN_KEY);
    const params = new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      post_logout_redirect_uri: `${window.location.origin}${returnTo}`,
    });
    if (idToken) {
      params.set('id_token_hint', idToken);
    }
    window.location.assign(`${realmUrl()}/logout?${params.toString()}`);
  },
};
