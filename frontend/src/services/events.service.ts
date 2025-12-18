import api from './api';
import { AccessEvent, AccessMethod, AccessResult } from '../types';

export interface EventsQueryDto {
  gateId?: string;
  method?: AccessMethod;
  result?: AccessResult;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface EventsResponse {
  events: AccessEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface EventsStats {
  totalEvents: number;
  allowedCount: number;
  deniedCount: number;
  byMethod: Record<string, number>;
  byGate: Record<string, { name: string; count: number }>;
}

export const eventsService = {
  async getAll(query?: EventsQueryDto): Promise<EventsResponse> {
    const response = await api.get<EventsResponse>('/events', { params: query });
    return response.data;
  },

  async getLive(gateId?: string, limit?: number): Promise<AccessEvent[]> {
    const response = await api.get<AccessEvent[]>('/events/live', {
      params: { gateId, limit },
    });
    return response.data;
  },

  async getStats(startDate: string, endDate: string, gateId?: string): Promise<EventsStats> {
    const response = await api.get<EventsStats>('/events/stats', {
      params: { startDate, endDate, gateId },
    });
    return response.data;
  },

  async exportCsv(query?: EventsQueryDto): Promise<Blob> {
    const response = await api.get('/events/export', {
      params: query,
      responseType: 'blob',
    });
    return response.data;
  },
};
