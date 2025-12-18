import api from './api';
import { SimulatorEvent, SimulatorFeedback, SensorHealthStatus } from '../types';

export interface TriggerEventDto {
  event: SimulatorEvent;
  rfidUid?: string;
  qrToken?: string;
}

export interface UpdateSensorDto {
  sensorType: string;
  status: SensorHealthStatus;
  value?: string;
  notes?: string;
}

export const simulatorService = {
  async triggerEvent(gateId: string, data: TriggerEventDto): Promise<SimulatorFeedback> {
    const response = await api.post<SimulatorFeedback>(`/simulator/${gateId}/trigger`, data);
    return response.data;
  },

  async setOnlineStatus(gateId: string, isOnline: boolean): Promise<void> {
    await api.patch(`/simulator/${gateId}/online`, { isOnline });
  },

  async updateSensor(gateId: string, data: UpdateSensorDto): Promise<void> {
    await api.patch(`/simulator/${gateId}/sensor`, data);
  },
};
