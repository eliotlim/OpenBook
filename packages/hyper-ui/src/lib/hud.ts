import {HudDefault, HudProps} from "@/providers";

export const HUD_STORAGE_KEY = 'hud';
export const loadHudStorage = () => {
  if (typeof window === 'undefined' || localStorage.getItem(HUD_STORAGE_KEY) === null) {
    return HudDefault;
  }
  return JSON.parse(localStorage.getItem(HUD_STORAGE_KEY) ?? '{}') as HudProps;
};

export const saveHudStorage = (hud: HudProps) => {
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(hud));
};
