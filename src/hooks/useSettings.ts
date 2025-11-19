import { useAppStore } from '../stores/AppStore';

export const useSettings = () => {
  const { settings, updateSettings } = useAppStore();
  return { settings, updateSettings };
};
