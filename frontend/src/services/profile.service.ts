import api from './api';
import { User } from '../types';

export interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface UploadImageResponse {
  message: string;
  profileImageUrl: string;
}

export const profileService = {
  async getProfile(): Promise<User> {
    const response = await api.get<User>('/users/profile');
    return response.data;
  },

  async updateProfile(data: UpdateProfileData): Promise<User> {
    const response = await api.patch<User>('/users/profile', data);
    return response.data;
  },

  async uploadProfileImage(file: File): Promise<UploadImageResponse> {
    const formData = new FormData();
    formData.append('image', file);

    const response = await api.post<UploadImageResponse>('/users/profile/upload-image', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },
};
