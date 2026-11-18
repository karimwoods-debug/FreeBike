import './style.css';
import { DeviceManager } from './ble/devices';
import { Game, CAMERA_MODES, QUALITY } from './game';
import { Route, ROUTES } from './world/route';
import { loadSettings, saveSettings, Settings } from './settings';
import { WORKOUTS, Workout, workoutDuration, workoutStateAt } from './workouts';
import { Recorder, download, loadHistory, saveToHistory } from './recorder';
import { Minimap, Profile, drawWorkoutChart, fmtDist, fmtSpeed, fmtTime } from './ui/hud';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const settings: Settings = loadSettings();
const devices = new DeviceManager();
let selectedRoute = 0;
let selectedWorkout: Workout = WORKOUTS[0];

// ---------------------------------------------------------------- menu ----

function renderDevices() {
  const list = $('device-list');
  const devs = devices.devices;
  if (!devs.length) {
    list.innerHTML = '<div class="hint">No sensors paired yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const d of devs) {
    const el = document.createElement('div');
    el.className = `device ${d.status}`;
    const r = d.readings;
    const live = [
      r.power !== undefined ? `${Math.round(r.power)} W` : '',
      r.cadence !== undefined ? `${Math.round(r.cadence)} rpm` : '',
      r.heartRate !== undefined ? `${r.heartRate} bpm` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    el.innerHTML = `<span class="dot"></span><span class="name"></span><span class="caps">${[...d.caps].join(', ') || d.status}</span><span class="live">${live}</span><button title="Forget">✕</button>`;
    el.querySelector('.name')!.textContent = d.name;
    el.querySelector('button')!.addEventListener('click', () => devices.remove(d.id));
    list.appendChild(el);
  }
}

function renderChoices() {
  const rl = $('route-list');
  rl.innerHTML = '';
  ROUTES.forEach((def, i) => {
    const r = new Route(def);
    const b = document.createElement('button');
    b.className = `choice${i === selectedRoute ? ' selected' : ''}`;
    const dist = settings.units === 'metric' ? `${(r.length / 1000).toFixed(1)} km` : `${(r.length / 1609.344).toFixed(1)} mi`;
    const asc = settings.units === 'metric' ? `${Math.round(r.totalAscent())} m` : `${Math.round(r.totalAscent() * 3.281)} ft`;
    b.innerHTML = `<b>${def.name}</b><small>${dist} lap · ${asc} climbing</small>`;
    b.onclick = () => {
      selectedRoute = i;
      renderChoices();
    };
    rl.appendChild(b);
  });
  const wl = $('workout-list');
  wl.innerHTML = '';
  for (const w of WORKOUTS) {
    const b = document.createElement('button');
    b.className = `choice${w === selectedWorkout ? ' selected' : ''}`;
    const dur = workoutDuration(w);
    b.innerHTML = `<b>${w.name}${dur ? ` · ${Math.round(dur / 60)} min` : ''}</b><small>${w.description}</small>`;
    b.onclick = () => {
      selectedWorkout = w;
      renderChoices();
    };
    wl.appendChild(b);
  }
}

function renderHistory() {
  const h = loadHistory();
  const el = $('history');
  if (!h.length) {
    el.innerHTML = '<div class="hint">No rides yet.</div>';
    return;
  }
  el.innerHTML = h
    .slice(0, 15)
    .map(
      (r) =>
        `<div class="ride"><span>${new Date(r.start).toLocaleDateString()} · ${fmtDist(r.distanceM, settings.units)} ${
          settings.units === 'metric' ? 'km' : 'mi'
        } · ${fmtTime(r.durationS)}</span><span>${r.avgPower} W avg · NP ${r.normalizedPower}</span></div>`,
    )
    .join('');
}

function bindSettings() {
  const num = (id: string, key: 'riderKg' | 'bikeKg' | 'ftp') => {
    const el = $<HTMLInputElement>(id);
    el.value = String(settings[key]);
    el.onchange = () => {
      const v = parseFloat(el.value);
      if (isFinite(v) && v > 0) settings[key] = v;
      saveSettings(settings);
    };
  };
  num('set-weight', 'riderKg');
  num('set-bike', 'bikeKg');
  num('set-ftp', 'ftp');
  const diff = $<HTMLInputElement>('set-diff');
  const diffVal = $('set-diff-val');
  diff.value = String(Math.round(settings.trainerDifficulty * 100));
  diffVal.textContent = `${diff.value}%`;
  diff.oninput = () => {
    settings.trainerDifficulty = parseInt(diff.value, 10) / 100;
    diffVal.textContent = `${diff.value}%`;
    saveSettings(settings);
  };
  const units = $<HTMLSelectElement>('set-units');
  units.value = settings.units;
  units.onchange = () => {
    settings.units = units.value as Settings['units'];
    saveSettings(settings);
    renderChoices();
    renderHistory();
  };
  const q = $<HTMLSelectElement>('set-quality');
  q.value = settings.quality;
  q.onchange = () => {
    settings.quality = q.value as Settings['quality'];
    saveSettings(settings);
  };
  const jersey = $<HTMLInputElement>('set-jersey');
  jersey.value = settings.jersey;
  jersey.onchange = () => {
    settings.jersey = jersey.value;
    saveSettings(settings);
  };
  const bots = $<HTMLInputElement>('set-bots');
  bots.checked = settings.bots;
  bots.onchange = () => {
    settings.bots = bots.checked;
    saveSettings(settings);
  };
}

function initMenu() {
  if (!DeviceManager.isSupported()) {
    const w = $('bt-warning');
    w.textContent = window.isSecureContext
      ? 'Web Bluetooth is not available in this browser. Use Chrome (Android, Windows, macOS, ChromeOS) or Edge. On iOS use the Bluefy browser. Simulator mode still works.'
      : 'Bluetooth requires HTTPS or localhost. Simulator mode still works.';
    w.classList.remove('hidden');
    $<HTMLInputElement>('sim-toggle').checked = true;
  }
  $('pair-btn').onclick = async () => {
    try {
      await devices.pair();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (!/cancel/i.test(msg)) alert(`Could not connect: ${msg}`);
    }
  };
  devices.onChange(renderDevices);
  setInterval(() => {
    if (!$('menu').classList.contains('hidden')) renderDevices();
  }, 700);
  renderDevices();
  renderChoices();
  renderHistory();
  bindSettings();
  $('start-btn').onclick = startRide;
}

// ---------------------------------------------------------------- ride ----

interface Ride {
  game: Game;
  recorder: Recorder;
  workout: Workout;
  minimap: Minimap;
  profile: Profile;
  time: number;
  paused: boolean;
  sim: boolean;
  simWatts: number;
  simHr: number;
  powerHist: number[];
  lastSample: number;
  lastTrainer: number;
  lap: number;
  raf: number;
  wakeLock?: WakeLockSentinel;
  noticeUntil: number;
  frames: number;
  fpsT: number;
}

let ride: Ride | null = null;

function notice(text: string, ms = 3000) {
  if (!ride) return;
  const n = $('notice');
  n.textContent = text;
  n.classList.remove('hidden');
  ride.noticeUntil = performance.now() + ms;
}

async function startRide() {
  const sim = $<HTMLInputElement>('sim-toggle').checked || devices.devices.length === 0;
  if (!sim && !devices.hasCapability('power')) {
    if (!confirm('No power source connected yet (trainer or power meter). Ride anyway?')) return;
  }
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('start-btn').textContent = 'Loading world…';
  // Give the browser a frame to paint before world generation.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  const route = new Route(ROUTES[selectedRoute]);
  const game = new Game($<HTMLCanvasElement>('scene'), route, QUALITY[settings.quality], {
    jersey: settings.jersey,
    bots: settings.bots,
    riderKg: settings.riderKg,
  });
  game.params = { ...game.params, riderKg: settings.riderKg, bikeKg: settings.bikeKg };

  ride = {
    game,
    recorder: new Recorder(),
    workout: selectedWorkout,
    minimap: new Minimap($<HTMLCanvasElement>('minimap'), route),
    profile: new Profile($<HTMLCanvasElement>('profile'), route),
    time: 0,
    paused: false,
    sim,
    simWatts: Math.round(settings.ftp * 0.6 / 5) * 5,
    simHr: 70,
    powerHist: [],
    lastSample: 0,
    lastTrainer: -10,
    lap: 0,
    raf: 0,
    noticeUntil: 0,
    frames: 0,
    fpsT: performance.now(),
  };
  $('sim-controls').classList.toggle('hidden', !sim);
  $('workout-box').classList.toggle('hidden', !ride.workout.intervals.length);
  $('m-dist-u').textContent = settings.units === 'metric' ? 'km' : 'mi';
  $('m-speed-u').textContent = settings.units === 'metric' ? 'km/h' : 'mph';
  $('start-btn').textContent = 'Start ride ▶';
  try {
    ride.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not critical */
  }
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    /* user may deny */
  }
  game.resize();
  notice(route.def.name, 2500);
  let last = performance.now();
  const loop = (now: number) => {
    if (!ride) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt, now);
    ride.raf = requestAnimationFrame(loop);
  };
  ride.raf = requestAnimationFrame(loop);
}

function currentInputs(r: Ride, target: number | null) {
  if (r.sim) {
    if (target !== null) r.simWatts = target; // simulated ERG
    const power = Math.max(0, r.simWatts + (r.simWatts > 0 ? Math.sin(r.time * 1.3) * 4 : 0));
    r.simHr += (Math.min(192, 60 + power * 0.42) - r.simHr) * 0.01;
    return { power, cadence: power > 0 ? 86 + Math.sin(r.time * 0.4) * 4 : 0, hr: Math.round(r.simHr) as number | undefined };
  }
  const rd = devices.readings();
  return { power: rd.power ?? 0, cadence: rd.cadence ?? 0, hr: rd.heartRate };
}

function tick(dt: number, now: number) {
  const r = ride!;
  const g = r.game;
  const units = settings.units;
  const wk = r.workout.intervals.length ? workoutStateAt(r.workout, r.time, settings.ftp) : null;
  const target = wk && !wk.done ? wk.target : null;

  if (!r.paused) {
    r.time += dt;
    const inp = currentInputs(r, target);
    g.update(dt, inp.power, inp.cadence, r.time);

    // Trainer control once per second: ERG for workouts, SIM (grade) otherwise.
    if (!r.sim && r.time - r.lastTrainer >= 1) {
      r.lastTrainer = r.time;
      if (target !== null) devices.setTargetPower(target);
      else devices.setGrade(g.route.gradeAt(g.player.distance) * settings.trainerDifficulty);
    }

    // 1 Hz recording.
    if (r.time - r.lastSample >= 1) {
      r.lastSample += 1;
      r.powerHist.push(inp.power);
      r.recorder.add({
        t: Math.round(r.time),
        power: Math.round(inp.power),
        cadence: inp.cadence ? Math.round(inp.cadence) : undefined,
        hr: inp.hr,
        speed: g.player.speed,
        distance: g.player.distance,
        altitude: g.route.heightAt(g.player.distance),
      });
    }

    const lap = Math.floor(g.player.distance / g.route.length);
    if (lap > r.lap) {
      r.lap = lap;
      notice(`Lap ${lap} complete!`);
    }

    // ---- HUD ----
    const p3 = r.powerHist.slice(-3);
    const p3avg = p3.length ? p3.reduce((a, b) => a + b, 0) / p3.length : inp.power;
    const avg = r.powerHist.length ? r.powerHist.reduce((a, b) => a + b, 0) / r.powerHist.length : 0;
    $('m-time').textContent = fmtTime(r.time);
    $('m-dist').textContent = fmtDist(g.player.distance, units);
    $('m-speed').textContent = fmtSpeed(g.player.speed, units);
    $('m-power').textContent = String(Math.round(p3avg));
    $('m-avg').textContent = `· avg ${Math.round(avg)}`;
    $('m-cad').textContent = inp.cadence ? String(Math.round(inp.cadence)) : '--';
    $('m-hr').textContent = inp.hr ? String(inp.hr) : '--';
    $('m-grade').textContent = `${g.route.gradeAt(g.player.distance).toFixed(1)}%`;
    $('draft').classList.toggle('hidden', g.player.drafting < 0.15);
    if (r.sim) $('sim-watts').textContent = `${Math.round(r.simWatts)} W`;

    if (wk) {
      $('wk-name').textContent = wk.done ? 'Workout complete 🎉' : wk.label;
      $('wk-remaining').textContent = wk.done ? '' : fmtTime(wk.intervalRemaining);
      $('wk-target').textContent = target !== null ? String(target) : '--';
      if (r.frames % 10 === 0) drawWorkoutChart($<HTMLCanvasElement>('wk-chart'), r.workout, settings.ftp, r.time);
    }
    if (r.frames % 3 === 0) {
      r.minimap.draw(g);
      const elev = g.route.heightAt(g.player.distance);
      r.profile.draw(g.player.distance, units === 'metric' ? `${Math.round(elev)} m` : `${Math.round(elev * 3.281)} ft`);
    }
    if (r.frames % 15 === 0) {
      $('standings').innerHTML = g
        .standings()
        .map((s) => {
          const gap = s.isPlayer ? '' : `${s.gap > 0 ? '+' : ''}${Math.round(s.gap)} m`;
          return `<div class="${s.isPlayer ? 'me' : ''}"><span>${s.name}</span><span>${gap}</span></div>`;
        })
        .join('');
    }
  }
  if (r.noticeUntil && now > r.noticeUntil) {
    $('notice').classList.add('hidden');
    r.noticeUntil = 0;
  }
  g.render();

  r.frames++;
  if (now - r.fpsT > 1000) {
    const st = g.stats();
    $('fps').textContent = `${r.frames} fps · ${st.calls} draws · ${(st.triangles / 1000).toFixed(0)}k tris`;
    r.frames = 0;
    r.fpsT = now;
  }
}

function setPaused(p: boolean) {
  if (!ride) return;
  ride.paused = p;
  $('pause').classList.toggle('hidden', !p);
}

function endRide() {
  if (!ride) return;
  cancelAnimationFrame(ride.raf);
  const s = ride.recorder.summary();
  if (s.durationS > 10) saveToHistory(s);
  const imperial = settings.units === 'imperial';
  $('summary-stats').innerHTML = [
    [fmtTime(s.durationS), 'Time'],
    [`${fmtDist(s.distanceM, settings.units)} ${imperial ? 'mi' : 'km'}`, 'Distance'],
    [`${s.avgPower} W`, 'Avg power'],
    [`${s.normalizedPower} W`, 'Normalized power'],
    [`${s.maxPower} W`, 'Max power'],
    [s.avgHr ? `${s.avgHr} bpm` : '--', 'Avg HR'],
    [imperial ? `${Math.round(s.elevationGainM * 3.281)} ft` : `${s.elevationGainM} m`, 'Elevation'],
    [`${s.kj} kJ`, 'Work'],
  ]
    .map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`)
    .join('');
  $('pause').classList.add('hidden');
  $('summary').classList.remove('hidden');
  const rec = ride.recorder;
  $('export-btn').onclick = () => {
    const name = `freebike-${rec.startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tcx`;
    download(name, rec.toTcx());
  };
  ride.wakeLock?.release().catch(() => undefined);
  ride.game.dispose();
  ride = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
}

$('menu-btn').onclick = () => {
  $('summary').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  renderHistory();
};
$('pause-btn').onclick = () => setPaused(!ride?.paused);
$('resume-btn').onclick = () => setPaused(false);
$('end-btn').onclick = () => {
  if (confirm('End ride?')) endRide();
};
$('cam-btn').onclick = cycleCamera;
$('sim-up').onclick = () => ride && (ride.simWatts = Math.min(1500, ride.simWatts + 25));
$('sim-down').onclick = () => ride && (ride.simWatts = Math.max(0, ride.simWatts - 25));

function cycleCamera() {
  if (!ride) return;
  const g = ride.game;
  g.cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(g.cameraMode) + 1) % CAMERA_MODES.length];
}

window.addEventListener('keydown', (e) => {
  if (!ride) return;
  if (e.key === 'ArrowUp') ride.simWatts = Math.min(1500, ride.simWatts + (e.shiftKey ? 50 : 10));
  else if (e.key === 'ArrowDown') ride.simWatts = Math.max(0, ride.simWatts - (e.shiftKey ? 50 : 10));
  else if (e.key === 'c' || e.key === 'C') cycleCamera();
  else if (e.key === ' ') {
    setPaused(!ride.paused);
    e.preventDefault();
  }
});
window.addEventListener('resize', () => ride?.game.resize());
document.addEventListener('visibilitychange', async () => {
  // Wake locks are released when the page is hidden; re-acquire on return.
  if (ride && document.visibilityState === 'visible') {
    try {
      ride.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* ignore */
    }
  }
});

// ------------------------------------------------------------- offline ----
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

initMenu();
