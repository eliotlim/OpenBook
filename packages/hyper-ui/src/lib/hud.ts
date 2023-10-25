export interface HudProps {
  commandPalette: {
    open: boolean;
  };
  settings: {
    open: boolean;
  };
  sideNav: {
    open: boolean;
    docked: boolean;
  };
  viewMode: {
    fullWidth: boolean;
  }
}

export const HudDefault: HudProps = {
  commandPalette: {
    open: false,
  },
  settings: {
    open: false,
  },
  sideNav: {
    open: false,
    docked: false,
  },
  viewMode: {
    fullWidth: false,
  },
};

export const HUD_STORAGE_KEY = 'hud';
export const loadHudStorage = () => {
  if (typeof window === 'undefined' || localStorage.getItem(HUD_STORAGE_KEY) === null) {
    return HudDefault;
  }
  return {
    ...HudDefault,
    ...JSON.parse(localStorage.getItem(HUD_STORAGE_KEY) ?? '{}')
  };
};

export const saveHudStorage = (hud: HudProps) => {
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(hud));
};
