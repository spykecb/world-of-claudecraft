// Pure parsers for the adb shell readouts scripts/orbit_bench.mjs samples on a phone
// during a run (`dumpsys thermalservice`, `dumpsys battery`), so a capture can be
// split into cool and throttled stretches. No I/O; tests/android_device_parse.test.ts
// feeds them recorded text.

/**
 * `dumpsys thermalservice`: the overall status (0 none, 1 light, 2 moderate,
 * 3 severe, 4 critical, 5 emergency, 6 shutdown) and the current sensor
 * temperatures by name. Only the "Current temperatures from HAL" block is read,
 * because the dump also lists cached and threshold values under the same shape.
 */
export function parseThermalService(text) {
  const src = String(text ?? '');
  const statusMatch = /Thermal Status:\s*(\d)/.exec(src);
  const marker = 'Current temperatures from HAL:';
  const at = src.indexOf(marker);
  let block = at >= 0 ? src.slice(at + marker.length) : src;
  const nextHeader = block.search(/\n\S[^\n]*:\s*\n/);
  if (at >= 0 && nextHeader > 0) block = block.slice(0, nextHeader);
  const temps = {};
  for (const m of block.matchAll(/mValue=(-?[\d.]+),\s*mType=\d+,\s*mName=([^,}]+)/g)) {
    const name = m[2].trim();
    if (!(name in temps)) temps[name] = Number(m[1]);
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    temps,
    activeCooling: parseActiveCooling(src),
  };
}

/**
 * The "Current cooling devices from HAL" block: a device with a non-zero value is
 * actively throttling (cpufreq-cpuN caps a CPU cluster, gpu or a kgsl devfreq entry
 * caps the GPU, thermal-pause-N parks cores). Returns { name: value } for the active
 * ones only, so an empty object means "nothing is being throttled right now".
 */
export function parseActiveCooling(text) {
  const src = String(text ?? '');
  const marker = 'Current cooling devices from HAL:';
  const at = src.indexOf(marker);
  if (at < 0) return {};
  let block = src.slice(at + marker.length);
  const nextHeader = block.search(/\n\S[^\n]*:\s*\n/);
  if (nextHeader > 0) block = block.slice(0, nextHeader);
  const active = {};
  for (const m of block.matchAll(/CoolingDevice\{mValue=(\d+),\s*mType=\d+,\s*mName=([^,}]+)\}/g)) {
    const value = Number(m[1]);
    if (value > 0) active[m[2].trim()] = value;
  }
  return active;
}

/** `dumpsys battery`: level (percent), temperature in Celsius, and charging sources. */
export function parseBattery(text) {
  const src = String(text ?? '');
  const num = (re) => {
    const m = re.exec(src);
    return m ? Number(m[1]) : null;
  };
  const flag = (name) => {
    const m = new RegExp(`${name} powered:\\s*(true|false)`).exec(src);
    return m ? m[1] === 'true' : null;
  };
  const tenths = num(/\n\s*temperature:\s*(-?\d+)/);
  return {
    level: num(/\n\s*level:\s*(\d+)/),
    tempC: tenths === null ? null : tenths / 10,
    ac: flag('AC'),
    usb: flag('USB'),
  };
}

/** `dumpsys power`: whether the screen is on (Awake) or asleep (Asleep, Dozing, Dreaming). */
export function parseWakefulness(text) {
  const m = /mWakefulness=(\w+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** `dumpsys window`: whether the lock screen is up (Chrome is then not visible, so
 *  requestAnimationFrame does not run even though the screen is Awake). */
export function parseKeyguardShowing(text) {
  const m = /isKeyguardShowing=(true|false)/.exec(String(text ?? ''));
  return m ? m[1] === 'true' : null;
}
