import api from './api';
import { Notification, NotificationCounts, NotificationType, NotificationPriority } from '../types';

export interface NotificationsQueryDto {
  type?: NotificationType;
  priority?: NotificationPriority;
  isRead?: boolean;
  page?: number;
  limit?: number;
}

export interface NotificationsResponse {
  notifications: Notification[];
  total: number;
  page: number;
  limit: number;
}

export const notificationService = {
  async getAll(query?: NotificationsQueryDto): Promise<NotificationsResponse> {
    const response = await api.get<NotificationsResponse>('/notifications', { params: query });
    return response.data;
  },

  async getUnread(limit?: number): Promise<Notification[]> {
    const response = await api.get<Notification[]>('/notifications/unread', {
      params: { limit },
    });
    return response.data;
  },

  async getCounts(): Promise<NotificationCounts> {
    const response = await api.get<NotificationCounts>('/notifications/counts');
    return response.data;
  },

  async markAsRead(ids: string[]): Promise<void> {
    await api.post('/notifications/mark-read', { ids });
  },

  async markAllAsRead(): Promise<void> {
    await api.post('/notifications/mark-all-read');
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/notifications/${id}`);
  },
};
