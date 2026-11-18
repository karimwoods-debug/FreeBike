/** Structured workouts, expressed relative to FTP. */
export interface Interval {
  seconds: number;
  /** Fraction of FTP at the start of the interval. */
  from: number;
  /** Fraction of FTP at the end (ramps); defaults to `from`. */
  to?: number;
  label?: string;
}

export interface Workout {
  id: string;
  name: string;
  description: string;
  intervals: Interval[];
}

const rep = (n: number, block: Interval[]): Interval[] => Array.from({ length: n }, () => block).flat();

export const WORKOUTS: Workout[] = [
  {
    id: 'free',
    name: 'Free ride',
    description: 'Just ride. Trainer follows the road gradient (SIM mode).',
    intervals: [],
  },
  {
    id: 'endurance45',
    name: 'Endurance 45',
    description: '45 min steady zone 2 with a short warm-up and cool-down.',
    intervals: [
      { seconds: 300, from: 0.45, to: 0.65, label: 'Warm-up' },
      { seconds: 2100, from: 0.68, label: 'Endurance' },
      { seconds: 300, from: 0.6, to: 0.4, label: 'Cool-down' },
    ],
  },
  {
    id: 'sweetspot3x10',
    name: 'Sweet Spot 3×10',
    description: '3 × 10 min at 90% FTP, 5 min recoveries.',
    intervals: [
      { seconds: 600, from: 0.45, to: 0.75, label: 'Warm-up' },
      ...rep(3, [
        { seconds: 600, from: 0.9, label: 'Sweet spot' },
        { seconds: 300, from: 0.5, label: 'Recover' },
      ]),
      { seconds: 300, from: 0.5, to: 0.4, label: 'Cool-down' },
    ],
  },
  {
    id: 'vo2-5x3',
    name: 'VO2max 5×3',
    description: '5 × 3 min at 115% FTP, 3 min recoveries.',
    intervals: [
      { seconds: 600, from: 0.45, to: 0.75, label: 'Warm-up' },
      ...rep(5, [
        { seconds: 180, from: 1.15, label: 'VO2max' },
        { seconds: 180, from: 0.5, label: 'Recover' },
      ]),
      { seconds: 300, from: 0.5, to: 0.4, label: 'Cool-down' },
    ],
  },
  {
    id: 'ramp',
    name: 'Ramp test',
    description: '+20 W per minute from 100 W until you stop. FTP ≈ 75% of best 1-min power.',
    intervals: [
      { seconds: 300, from: 0.4, to: 0.5, label: 'Warm-up' },
      // Absolute wattages are handled in `targetAt` via negative "from".
      ...Array.from({ length: 30 }, (_, i) => ({ seconds: 60, from: -(100 + i * 20), label: `Ramp ${100 + i * 20} W` })),
    ],
  },
];

export function workoutDuration(w: Workout): number {
  return w.intervals.reduce((a, i) => a + i.seconds, 0);
}

export interface WorkoutState {
  index: number;
  intervalElapsed: number;
  intervalRemaining: number;
  target: number;
  label: string;
  done: boolean;
}

/** Target power (W) at time t seconds into the workout. */
export function workoutStateAt(w: Workout, t: number, ftp: number): WorkoutState {
  let acc = 0;
  for (let i = 0; i < w.intervals.length; i++) {
    const iv = w.intervals[i];
    if (t < acc + iv.seconds) {
      const e = t - acc;
      const watts = (frac: number) => (frac < 0 ? -frac : frac * ftp);
      const a = watts(iv.from);
      const b = watts(iv.to ?? iv.from);
      return {
        index: i,
        intervalElapsed: e,
        intervalRemaining: iv.seconds - e,
        target: Math.round(a + (b - a) * (e / iv.seconds)),
        label: iv.label ?? '',
        done: false,
      };
    }
    acc += iv.seconds;
  }
  return { index: w.intervals.length, intervalElapsed: 0, intervalRemaining: 0, target: 0, label: 'Done', done: true };
}
