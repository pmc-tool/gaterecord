import { create } from 'zustand';
import { User, AuthTokens, LoginCredentials } from '../types';
import { authService } from '../services/auth.service';

interface AuthStore {
  user: User | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
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

  logout: async () => {
    const { tokens } = get();
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
      set({ isAuthenticated: false, user: null, tokens: null });
      return;
    }

    try {
      const user = await authService.getCurrentUser();
      authService.saveUser(user);
      set({ user, isAuthenticated: true });
    } catch {
      authService.clearAuth();
      set({ isAuthenticated: false, user: null, tokens: null });
    }
  },

  clearError: () => set({ error: null }),
}));
