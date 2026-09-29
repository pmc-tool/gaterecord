import { create } from 'zustand';
import { User, AuthTokens, LoginCredentials } from '../types';
import { authService } from '../services/auth.service';
import { oidcService } from '../services/oidc.service';

interface AuthStore {
  user: User | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (credentials: LoginCredentials) => Promise<void>;
  /** Finish a YAAD-account (Keycloak) sign-in with the tokens from /auth/callback. */
  loginWithOidc: (tokens: AuthTokens) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  setAuth: (user: User, tokens: AuthTokens) => void;
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: authService.getUser(),
  tokens: authService.getTokens(),
  isAuthenticated: !!authService.getTokens(),
  isLoading: false,
  error: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authService.login(credentials);
      authService.saveTokens({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      });
      authService.saveUser(response.user);
      set({
        user: response.user,
        tokens: {
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
        },
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Login failed',
        isLoading: false,
      });
      throw error;
    }
  },

  loginWithOidc: async (tokens: AuthTokens) => {
    set({ isLoading: true, error: null });
    authService.saveTokens(tokens, 'keycloak');
    try {
      // The first request with a Keycloak token also creates or links the
      // person's gate_users row on the backend.
      const user = await authService.getCurrentUser();
      authService.saveUser(user);
      set({ user, tokens, isAuthenticated: true, isLoading: false });
    } catch (error) {
      authService.clearAuth();
      set({
        user: null,
        tokens: null,
        isAuthenticated: false,
        error: error instanceof Error ? error.message : 'Login failed',
        isLoading: false,
      });
      throw error;
    }
  },

  logout: async () => {
    const { tokens } = get();
    if (authService.getProvider() === 'keycloak') {
      // No gaterecord session to revoke; end the Keycloak one (full redirect).
      authService.clearAuth();
      set({ user: null, tokens: null, isAuthenticated: false });
      oidcService.logout();
      return;
    }
    try {
      if (tokens?.refreshToken) {
        await authService.logout(tokens.refreshToken);
      }
    } finally {
      authService.clearAuth();
      set({
        user: null,
        tokens: null,
        isAuthenticated: false,
      });
    }
  },

  checkAuth: async () => {
    const tokens = authService.getTokens();
    if (!tokens) {
      set({ isAuthenticated: false, user: null, tokens: null, isLoading: false });
      return;
    }

    set({ isLoading: true });
    try {
      const user = await authService.getCurrentUser();
      authService.saveUser(user);
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      authService.clearAuth();
      set({ isAuthenticated: false, user: null, tokens: null, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),

  setAuth: (user: User, tokens: AuthTokens) => {
    authService.saveTokens(tokens);
    authService.saveUser(user);
    set({
      user,
      tokens,
      isAuthenticated: true,
    });
  },

  setUser: (user: User) => {
    authService.saveUser(user);
    set({ user });
  },
}));
