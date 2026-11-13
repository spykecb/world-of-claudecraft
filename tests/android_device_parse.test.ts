import { describe, expect, it } from 'vitest';
import {
  parseActiveCooling,
  parseBattery,
  parseKeyguardShowing,
  parseThermalService,
  parseWakefulness,
} from '../scripts/lib/android_device_parse.mjs';

// Trimmed from a real `adb shell dumpsys thermalservice` on a Snapdragon 7s Gen 3 phone.
// The CACHED block deliberately carries different values from the HAL block: only the
// HAL block is current.
const THERMAL = `IsStatusOverride: false
ThermalStatusListeners:
\tcallbacks: 15
Thermal Status: 0
Cached temperatures:
\tTemperature{mValue=31.459, mType=2, mName=battery, mStatus=0}
\tTemperature{mValue=50.9, mType=0, mName=CPU0, mStatus=0}
\tTemperature{mValue=45.5, mType=1, mName=GPU0, mStatus=0}
\tTemperature{mValue=34.934, mType=3, mName=skin, mStatus=0}
HAL Ready: true
Current temperatures from HAL:
\tTemperature{mValue=26.17, mType=2, mName=battery, mStatus=0}
\tTemperature{mValue=33.3, mType=1, mName=GPU0, mStatus=0}
\tTemperature{mValue=32.2, mType=0, mName=CPU7, mStatus=0}
\tTemperature{mValue=27.246, mType=3, mName=skin, mStatus=0}
\tTemperature{mValue=35.4, mType=0, mName=CPU0, mStatus=0}
Current cooling devices from HAL:
\tCoolingDevice{mValue=0, mType=2, mName=thermal-pause-20}
\tCoolingDevice{mValue=0, mType=2, mName=cpufreq-cpu7}
\tCoolingDevice{mValue=0, mType=3, mName=gpu}
Temperature static thresholds from HAL:
\tTemperatureThreshold{mType=2, mName=battery, mHotThrottlingThresholds=[NaN, NaN, NaN, 80.0, NaN, NaN, 90.0]}
`;

const THROTTLED = THERMAL.replace('Thermal Status: 0', 'Thermal Status: 2')
  .replace('mValue=0, mType=2, mName=cpufreq-cpu7', 'mValue=3, mType=2, mName=cpufreq-cpu7')
  .replace('mValue=0, mType=3, mName=gpu', 'mValue=1, mType=3, mName=gpu');

describe('parseThermalService', () => {
  it('reads the status and only the current HAL temperatures, not the cached ones', () => {
    const reading = parseThermalService(THERMAL);
    expect(reading.status).toBe(0);
    expect(reading.temps).toEqual({
      battery: 26.17,
      GPU0: 33.3,
      CPU7: 32.2,
      skin: 27.246,
      CPU0: 35.4,
    });
    expect(reading.temps.CPU0).not.toBe(50.9);
  });

  it('reports no active cooling on a cool phone and names the throttling devices on a hot one', () => {
    expect(parseThermalService(THERMAL).activeCooling).toEqual({});
    const hot = parseThermalService(THROTTLED);
    expect(hot.status).toBe(2);
    expect(hot.activeCooling).toEqual({ 'cpufreq-cpu7': 3, gpu: 1 });
  });

  it('returns a null status and empty maps for unrelated text', () => {
    expect(parseThermalService('nothing here')).toEqual({
      status: null,
      temps: {},
      activeCooling: {},
    });
    expect(parseActiveCooling('')).toEqual({});
  });
});

describe('parseBattery', () => {
  it('reads level, temperature in Celsius and the charging source', () => {
    const text = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Max charging current: 900000
  level: 20
  scale: 100
  voltage: 3773
  temperature: 250
  technology: Li-ion`;
    expect(parseBattery(text)).toEqual({ level: 20, tempC: 25, ac: false, usb: true });
  });

  it('does not mistake "Charge counter" or "scale" for the level', () => {
    expect(parseBattery('Charge counter: 925497\n  scale: 100\n')).toEqual({
      level: null,
      tempC: null,
      ac: null,
      usb: null,
    });
  });
});

describe('parseKeyguardShowing', () => {
  it('reads whether the lock screen hides Chrome', () => {
    expect(parseKeyguardShowing('    isKeyguardShowing=true\n')).toBe(true);
    expect(parseKeyguardShowing('    isKeyguardShowing=false\n')).toBe(false);
    expect(parseKeyguardShowing('mDreamingLockscreen=true')).toBeNull();
  });
});

describe('parseWakefulness', () => {
  it('reads the screen state that tells whether rAF can run', () => {
    expect(parseWakefulness('  mWakefulness=Awake\n')).toBe('Awake');
    expect(parseWakefulness('  mWakefulness=Dozing\n')).toBe('Dozing');
    expect(parseWakefulness('')).toBeNull();
  });
});
