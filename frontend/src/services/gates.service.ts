import api from './api';
import { Gate, GateHealth, GateType } from '../types';

export interface CreateGateDto {
  name: string;
  type: GateType;
  location?: string;
  description?: string;
}

export interface UpdateGateDto extends Partial<CreateGateDto> {
  isOnline?: boolean;
}

export const gatesService = {
  async getAll(): Promise<Gate[]> {
    const response = await api.get<Gate[]>('/gates');
    return response.data;
  },

  async getById(id: string): Promise<Gate> {
    const response = await api.get<Gate>(`/gates/${id}`);
    return response.data;
  },

  async getHealth(id: string): Promise<GateHealth> {
    const response = await api.get<GateHealth>(`/gates/${id}/health`);
    return response.data;
  },

  async create(data: CreateGateDto): Promise<Gate> {
    const response = await api.post<Gate>('/gates', data);
    return response.data;
  },

  async update(id: string, data: UpdateGateDto): Promise<Gate> {
    const response = await api.patch<Gate>(`/gates/${id}`, data);
    return response.data;
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/gates/${id}`);
  },
};
