import api from './api';

export interface NotificationSettings {
  emailNotifications: boolean;
  inAppNotifications: boolean;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface LoginActivity {
  id: string;
  status: 'success' | 'failed';
  ipAddress: string;
  userAgent: string;
  browser: string;
  os: string;
  device: string;
  location: string | null;
  failureReason: string | null;
  createdAt: string;
}

export const settingsService = {
  // Password
  async changePassword(data: ChangePasswordData): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/settings/change-password', data);
    return response.data;
  },

  /** After Keycloak reports the password changed: clears the temporary-password reminder. */
  async acknowledgePasswordUpdated(): Promise<void> {
    await api.post('/settings/password-updated');
  },

  // Notifications
  async getNotificationSettings(): Promise<NotificationSettings> {
    const response = await api.get<NotificationSettings>('/settings/notifications');
    return response.data;
  },

  async updateNotificationSettings(data: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const response = await api.patch<NotificationSettings>('/settings/notifications', data);
    return response.data;
  },

  // Login Activity
  async getLoginActivity(limit?: number): Promise<LoginActivity[]> {
    const response = await api.get<LoginActivity[]>('/settings/login-activity', {
      params: { limit },
    });
    return response.data;
  },
};
