export type Quality = 'ps2' | 'low' | 'high';
export type Units = 'metric' | 'imperial';

export interface Settings {
  riderKg: number;
  bikeKg: number;
  ftp: number;
  /** Fraction (0..1) of the real grade sent to the trainer, like Zwift's trainer difficulty. */
  trainerDifficulty: number;
  units: Units;
  quality: Quality;
  bots: boolean;
  jersey: string;
}

const KEY = 'freebike.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  riderKg: 75,
  bikeKg: 9,
  ftp: 200,
  trainerDifficulty: 0.5,
  units: 'metric',
  quality: 'ps2',
  bots: true,
  jersey: '#e8452c',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
