/** Records 1 Hz samples and exports a TCX file (accepted by Strava, Garmin Connect, intervals.icu, TrainingPeaks...). */
export interface Sample {
  t: number; // seconds since start
  power: number;
  cadence?: number;
  hr?: number;
  speed: number; // m/s
  distance: number; // m
  altitude: number; // m
}

export interface RideSummary {
  id: string;
  start: string;
  durationS: number;
  distanceM: number;
  avgPower: number;
  maxPower: number;
  normalizedPower: number;
  avgHr?: number;
  elevationGainM: number;
  kj: number;
}

const HISTORY_KEY = 'freebike.history.v1';

export class Recorder {
  readonly startedAt = new Date();
  samples: Sample[] = [];
  elevationGain = 0;
  private lastAlt?: number;

  add(s: Sample) {
    if (this.lastAlt !== undefined && s.altitude > this.lastAlt) this.elevationGain += s.altitude - this.lastAlt;
    this.lastAlt = s.altitude;
    this.samples.push(s);
  }

  summary(): RideSummary {
    const n = this.samples.length;
    const powers = this.samples.map((s) => s.power);
    const hrs = this.samples.map((s) => s.hr).filter((h): h is number => !!h);
    const sum = powers.reduce((a, b) => a + b, 0);
    return {
      id: this.startedAt.toISOString(),
      start: this.startedAt.toISOString(),
      durationS: n,
      distanceM: n ? this.samples[n - 1].distance : 0,
      avgPower: n ? Math.round(sum / n) : 0,
      maxPower: n ? Math.max(...powers) : 0,
      normalizedPower: Math.round(normalizedPower(powers)),
      avgHr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
      elevationGainM: Math.round(this.elevationGain),
      kj: Math.round(sum / 1000),
    };
  }

  toTcx(): string {
    const s = this.summary();
    const iso = (t: number) => new Date(this.startedAt.getTime() + t * 1000).toISOString();
    const pts = this.samples
      .map(
        (p) => `        <Trackpoint>
          <Time>${iso(p.t)}</Time>
          <AltitudeMeters>${p.altitude.toFixed(1)}</AltitudeMeters>
          <DistanceMeters>${p.distance.toFixed(1)}</DistanceMeters>${
            p.hr ? `\n          <HeartRateBpm><Value>${Math.round(p.hr)}</Value></HeartRateBpm>` : ''
          }${p.cadence !== undefined ? `\n          <Cadence>${Math.round(p.cadence)}</Cadence>` : ''}
          <Extensions><ns3:TPX><ns3:Speed>${p.speed.toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(p.power)}</ns3:Watts></ns3:TPX></Extensions>
        </Trackpoint>`,
      )
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${this.startedAt.toISOString()}</Id>
      <Lap StartTime="${this.startedAt.toISOString()}">
        <TotalTimeSeconds>${s.durationS}</TotalTimeSeconds>
        <DistanceMeters>${s.distanceM.toFixed(1)}</DistanceMeters>
        <Calories>${Math.round(s.kj * 1.0)}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${pts}
        </Track>
      </Lap>
      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>FreeBike</Name></Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
  }
}

export function normalizedPower(powers: number[]): number {
  if (powers.length < 30) return powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : 0;
  let acc = 0;
  let win = 0;
  let count = 0;
  for (let i = 0; i < powers.length; i++) {
    win += powers[i];
    if (i >= 30) win -= powers[i - 30];
    if (i >= 29) {
      acc += Math.pow(win / 30, 4);
      count++;
    }
  }
  return Math.pow(acc / count, 0.25);
}

export function loadHistory(): RideSummary[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveToHistory(s: RideSummary) {
  try {
    const h = loadHistory().filter((r) => r.id !== s.id);
    h.unshift(s);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 100)));
  } catch {
    /* ignore */
  }
}

export function download(filename: string, text: string, mime = 'application/xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
