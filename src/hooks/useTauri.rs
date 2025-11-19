import { invoke } from '@tauri-apps/api';

export const useTauri = () => {
  return { invoke };
};