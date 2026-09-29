import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { oidcService } from './oidc.service';

const API_URL = import.meta.env.VITE_API_URL || 'https://dev-api.gaterecord.com/api/v1';

const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle token refresh
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    if (error.response?.status === 401 && !originalRequest._retry) {
      // Check if this is a login error (not a token expiry)
      const isLoginError = originalRequest.url?.includes('/auth/login');
      if (isLoginError) {
        const message = error.response?.data?.message || 'Login failed';
        return Promise.reject(new Error(message));
      }

      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) {
          throw new Error('No refresh token');
        }

        // YAAD-account tokens are refreshed by Keycloak, not by gaterecord.
        const { accessToken, refreshToken: newRefreshToken } =
          localStorage.getItem('authProvider') === 'keycloak'
            ? await oidcService.refresh(refreshToken)
            : (await axios.post(`${API_URL}/auth/refresh`, { refreshToken })).data;

        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', newRefreshToken);

        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        localStorage.removeItem('authProvider');
        localStorage.removeItem('idToken');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // Extract error message from response for other errors
    const message = error.response?.data?.message || error.message || 'An error occurred';
    return Promise.reject(new Error(message));
  }
);

export default api;
