/**
 * Bluetooth LE device manager.
 *
 * Talks only standard Bluetooth SIG profiles, which is what Magene
 * (T300 / T110 trainers, P505 / PES power meters, S3+ speed/cadence,
 * H64 / H303 HR straps) and most other brands (Wahoo, Tacx, Elite, Saris,
 * JetBlack, Garmin, Stages, Favero...) implement:
 *
 *  - FTMS  0x1826 smart trainer (data + ERG / SIM control)
 *  - CPS   0x1818 power meter (also older trainers that don't do FTMS)
 *  - CSC   0x1816 speed / cadence sensor
 *  - HRS   0x180D heart-rate monitor
 */
import {
  FtmsCommand,
  RevolutionRate,
  parseCsc,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
} from './parsers';

const FTMS = 0x1826;
const CPS = 0x1818;
const CSC = 0x1816;
const HRS = 0x180d;

const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CYCLING_POWER_MEASUREMENT = 0x2a63;
const CSC_MEASUREMENT = 0x2a5b;
const HEART_RATE_MEASUREMENT = 0x2a37;

export type Capability = 'trainer' | 'power' | 'cadence' | 'speed' | 'hr';

export interface SensorReadings {
  power?: number;
  cadence?: number;
  heartRate?: number;
  /** Speed reported by trainer / wheel sensor, km/h (informational only). */
  speedKmh?: number;
}

export interface ConnectedDevice {
  id: string;
  name: string;
  caps: Set<Capability>;
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  readings: SensorReadings;
  lastUpdate: Record<string, number>;
}

type Listener = () => void;

interface DeviceHandle {
  info: ConnectedDevice;
  device: BluetoothDevice;
  controlPoint?: BluetoothRemoteGATTCharacteristic;
  crankRate: RevolutionRate;
  wheelRate: RevolutionRate;
  cscWheelRate: RevolutionRate;
  wantConnected: boolean;
  writeQueue: Promise<unknown>;
}

const STALE_MS = 4000;
const WHEEL_CIRCUMFERENCE_M = 2.105; // 700x25c

export class DeviceManager {
  private handles = new Map<string, DeviceHandle>();
  private listeners = new Set<Listener>();
  private lastTrainerCmd = '';

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  get devices(): ConnectedDevice[] {
    return [...this.handles.values()].map((h) => h.info);
  }

  /** Opens the browser device chooser and connects to whatever is picked. */
  async pair(): Promise<void> {
    if (!DeviceManager.isSupported()) {
      throw new Error(
        'Web Bluetooth is not available. Use Chrome on Android / desktop over HTTPS or localhost.',
      );
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }, { services: [CPS] }, { services: [CSC] }, { services: [HRS] }],
      optionalServices: [FTMS, CPS, CSC, HRS],
    });
    if (this.handles.has(device.id)) {
      const h = this.handles.get(device.id)!;
      h.wantConnected = true;
      await this.connect(h);
      return;
    }
    const handle: DeviceHandle = {
      info: {
        id: device.id,
        name: device.name || 'Unknown sensor',
        caps: new Set(),
        status: 'connecting',
        readings: {},
        lastUpdate: {},
      },
      device,
      crankRate: new RevolutionRate(1024),
      wheelRate: new RevolutionRate(2048, 0xffffffff),
      cscWheelRate: new RevolutionRate(1024, 0xffffffff),
      wantConnected: true,
      writeQueue: Promise.resolve(),
    };
    this.handles.set(device.id, handle);
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected(handle));
    this.emit();
    await this.connect(handle);
  }

  async remove(id: string): Promise<void> {
    const h = this.handles.get(id);
    if (!h) return;
    h.wantConnected = false;
    try {
      h.device.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.handles.delete(id);
    this.emit();
  }

  private async onDisconnected(h: DeviceHandle) {
    h.controlPoint = undefined;
    if (!h.wantConnected) return;
    h.info.status = 'reconnecting';
    this.emit();
    for (let attempt = 0; attempt < 8 && h.wantConnected; attempt++) {
      await new Promise((r) => setTimeout(r, 1000 + attempt * 1500));
      try {
        await this.connect(h);
        return;
      } catch {
        /* retry */
      }
    }
    h.info.status = 'disconnected';
    this.emit();
  }

  private async connect(h: DeviceHandle) {
    h.info.status = h.info.status === 'reconnecting' ? 'reconnecting' : 'connecting';
    this.emit();
    const server = await h.device.gatt!.connect();
    const services = await server.getPrimaryServices();
    const uuids = new Set(services.map((s) => s.uuid));
    const has = (n: number) => uuids.has(BluetoothUUID.getService(n));
    h.info.caps.clear();

    // A trainer exposing FTMS: prefer that for power + control.
    if (has(FTMS)) {
      const svc = await server.getPrimaryService(FTMS);
      try {
        const data = await svc.getCharacteristic(INDOOR_BIKE_DATA);
        data.addEventListener('characteristicvaluechanged', (e) =>
          this.onIndoorBikeData(h, (e.target as BluetoothRemoteGATTCharacteristic).value!),
        );
        await data.startNotifications();
        h.info.caps.add('trainer');
        h.info.caps.add('power');
      } catch (err) {
        console.warn('FTMS indoor bike data unavailable', err);
      }
      try {
        const cp = await svc.getCharacteristic(FTMS_CONTROL_POINT);
        cp.addEventListener('characteristicvaluechanged', (e) => {
          const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
          if (v.getUint8(0) === 0x80 && v.getUint8(2) !== 0x01) {
            console.warn(`FTMS op 0x${v.getUint8(1).toString(16)} result ${v.getUint8(2)}`);
          }
        });
        await cp.startNotifications(); // indications must be on before writes
        h.controlPoint = cp;
        await this.write(h, FtmsCommand.requestControl());
        await this.write(h, FtmsCommand.start());
        this.lastTrainerCmd = '';
      } catch (err) {
        console.warn('FTMS control point unavailable', err);
      }
    }

    // Cycling power. Skip it on FTMS trainers that already gave us power to
    // avoid double-counting (many trainers expose both).
    if (has(CPS) && !h.info.caps.has('trainer')) {
      const svc = await server.getPrimaryService(CPS);
      const ch = await svc.getCharacteristic(CYCLING_POWER_MEASUREMENT);
      ch.addEventListener('characteristicvaluechanged', (e) =>
        this.onCyclingPower(h, (e.target as BluetoothRemoteGATTCharacteristic).value!),
      );
      await ch.startNotifications();
      h.info.caps.add('power');
    }

    if (has(CSC)) {
      const svc = await server.getPrimaryService(CSC);
      const ch = await svc.getCharacteristic(CSC_MEASUREMENT);
      ch.addEventListener('characteristicvaluechanged', (e) =>
        this.onCsc(h, (e.target as BluetoothRemoteGATTCharacteristic).value!),
      );
      await ch.startNotifications();
    }

    if (has(HRS)) {
      const svc = await server.getPrimaryService(HRS);
      const ch = await svc.getCharacteristic(HEART_RATE_MEASUREMENT);
      ch.addEventListener('characteristicvaluechanged', (e) => {
        this.set(h, 'heartRate', parseHeartRate((e.target as BluetoothRemoteGATTCharacteristic).value!));
      });
      await ch.startNotifications();
      h.info.caps.add('hr');
    }

    h.info.status = 'connected';
    this.emit();
  }

  private set(h: DeviceHandle, key: keyof SensorReadings, value: number) {
    h.info.readings[key] = value;
    h.info.lastUpdate[key] = performance.now();
  }

  private onIndoorBikeData(h: DeviceHandle, dv: DataView) {
    const d = parseIndoorBikeData(dv);
    if (d.power !== undefined) this.set(h, 'power', Math.max(0, d.power));
    if (d.cadence !== undefined) {
      this.set(h, 'cadence', d.cadence);
      h.info.caps.add('cadence');
    }
    if (d.speedKmh !== undefined) this.set(h, 'speedKmh', d.speedKmh);
    if (d.heartRate) {
      this.set(h, 'heartRate', d.heartRate);
      h.info.caps.add('hr');
    }
  }

  private onCyclingPower(h: DeviceHandle, dv: DataView) {
    const now = performance.now();
    const d = parseCyclingPower(dv);
    this.set(h, 'power', Math.max(0, d.power));
    if (d.crank) {
      this.set(h, 'cadence', h.crankRate.update(d.crank.revs, d.crank.time, now));
      h.info.caps.add('cadence');
    }
    if (d.wheel) {
      const rpm = h.wheelRate.update(d.wheel.revs, d.wheel.time, now);
      this.set(h, 'speedKmh', (rpm * WHEEL_CIRCUMFERENCE_M * 60) / 1000);
    }
  }

  private onCsc(h: DeviceHandle, dv: DataView) {
    const now = performance.now();
    const d = parseCsc(dv);
    if (d.crank) {
      this.set(h, 'cadence', h.crankRate.update(d.crank.revs, d.crank.time, now));
      h.info.caps.add('cadence');
    }
    if (d.wheel) {
      const rpm = h.cscWheelRate.update(d.wheel.revs, d.wheel.time, now);
      this.set(h, 'speedKmh', (rpm * WHEEL_CIRCUMFERENCE_M * 60) / 1000);
      h.info.caps.add('speed');
    }
  }

  /**
   * Merged readings across all devices. Priority: dedicated sensors beat
   * trainer-reported values (power meter > trainer power, CSC/PM cadence >
   * trainer cadence, strap HR > trainer HR).
   */
  readings(): SensorReadings {
    const now = performance.now();
    const out: SensorReadings = {};
    // Coasting crank sensors stop notifying; decay cadence to zero.
    for (const h of this.handles.values()) {
      if (!h.info.caps.has('trainer') && h.info.readings.cadence !== undefined) {
        h.info.readings.cadence = h.crankRate.current(now);
      }
    }
    const pick = (key: keyof SensorReadings, prefer: (h: DeviceHandle) => number) => {
      let best: { score: number; value: number } | undefined;
      for (const h of this.handles.values()) {
        const v = h.info.readings[key];
        const t = h.info.lastUpdate[key];
        if (v === undefined || t === undefined || now - t > STALE_MS) continue;
        const score = prefer(h);
        if (!best || score > best.score) best = { score, value: v };
      }
      if (best) out[key] = best.value;
    };
    const notTrainer = (h: DeviceHandle) => (h.info.caps.has('trainer') ? 0 : 1);
    pick('power', notTrainer);
    pick('cadence', notTrainer);
    pick('heartRate', notTrainer);
    pick('speedKmh', notTrainer);
    return out;
  }

  hasTrainerControl(): boolean {
    for (const h of this.handles.values()) if (h.controlPoint) return true;
    return false;
  }

  hasCapability(cap: Capability): boolean {
    for (const h of this.handles.values()) {
      if (h.info.status === 'connected' && h.info.caps.has(cap)) return true;
    }
    return false;
  }

  /** ERG mode: hold the given wattage. */
  setTargetPower(watts: number) {
    this.sendTrainer(`erg:${Math.round(watts)}`, FtmsCommand.setTargetPower(watts));
  }

  /** SIM mode: grade in percent (already scaled by trainer difficulty). */
  setGrade(gradePct: number) {
    const g = Math.round(gradePct * 10) / 10;
    this.sendTrainer(`sim:${g}`, FtmsCommand.setSimulation(g));
  }

  private sendTrainer(key: string, cmd: Uint8Array) {
    if (key === this.lastTrainerCmd) return;
    this.lastTrainerCmd = key;
    for (const h of this.handles.values()) {
      if (h.controlPoint) this.write(h, cmd).catch((e) => console.warn('trainer write failed', e));
    }
  }

  private write(h: DeviceHandle, data: Uint8Array): Promise<unknown> {
    // GATT operations must not overlap; serialise them per device.
    h.writeQueue = h.writeQueue
      .catch(() => undefined)
      .then(() => {
        const cp = h.controlPoint;
        if (!cp) return;
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        return cp.writeValueWithResponse ? cp.writeValueWithResponse(buf) : cp.writeValue(buf);
      });
    return h.writeQueue;
  }
}
