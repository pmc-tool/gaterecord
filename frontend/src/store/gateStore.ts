import { create } from 'zustand';
import { Gate, GateHealth, GateState } from '../types';
import { gatesService, CreateGateDto, UpdateGateDto } from '../services/gates.service';

interface GateStore {
  gates: Gate[];
  selectedGate: Gate | null;
  gateHealth: GateHealth | null;
  isLoading: boolean;
  error: string | null;

  fetchGates: () => Promise<void>;
  fetchGateById: (id: string) => Promise<void>;
  fetchGateHealth: (id: string) => Promise<void>;
  createGate: (data: CreateGateDto) => Promise<void>;
  updateGate: (id: string, data: UpdateGateDto) => Promise<void>;
  deleteGate: (id: string) => Promise<void>;
  updateGateState: (id: string, state: GateState) => void;
  clearError: () => void;
}

export const useGateStore = create<GateStore>((set) => ({
  gates: [],
  selectedGate: null,
  gateHealth: null,
  isLoading: false,
  error: null,

  fetchGates: async () => {
    set({ isLoading: true, error: null });
    try {
      const gates = await gatesService.getAll();
      set({ gates, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch gates',
        isLoading: false,
      });
    }
  },

  fetchGateById: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const gate = await gatesService.getById(id);
      set({ selectedGate: gate, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch gate',
        isLoading: false,
      });
    }
  },

  fetchGateHealth: async (id: string) => {
    try {
      const health = await gatesService.getHealth(id);
      set({ gateHealth: health });
    } catch (error) {
      console.error('Failed to fetch gate health:', error);
    }
  },

  createGate: async (data: CreateGateDto) => {
    set({ isLoading: true, error: null });
    try {
      const gate = await gatesService.create(data);
      set((state) => ({
        gates: [...state.gates, gate],
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to create gate',
        isLoading: false,
      });
      throw error;
    }
  },

  updateGate: async (id: string, data: UpdateGateDto) => {
    set({ isLoading: true, error: null });
    try {
      const updatedGate = await gatesService.update(id, data);
      set((state) => ({
        gates: state.gates.map((g) => (g.id === id ? updatedGate : g)),
        selectedGate: state.selectedGate?.id === id ? updatedGate : state.selectedGate,
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to update gate',
        isLoading: false,
      });
      throw error;
    }
  },

  deleteGate: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      await gatesService.delete(id);
      set((state) => ({
        gates: state.gates.filter((g) => g.id !== id),
        selectedGate: state.selectedGate?.id === id ? null : state.selectedGate,
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete gate',
        isLoading: false,
      });
      throw error;
    }
  },

  updateGateState: (id: string, state: GateState) => {
    set((store) => ({
      gates: store.gates.map((g) => (g.id === id ? { ...g, state } : g)),
      selectedGate: store.selectedGate?.id === id ? { ...store.selectedGate, state } : store.selectedGate,
    }));
  },

  clearError: () => set({ error: null }),
}));
