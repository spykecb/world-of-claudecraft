export interface ThermalReading {
  status: number | null;
  temps: Record<string, number>;
  activeCooling: Record<string, number>;
}

export interface BatteryReading {
  level: number | null;
  tempC: number | null;
  ac: boolean | null;
  usb: boolean | null;
}

export declare function parseThermalService(text: string): ThermalReading;
export declare function parseActiveCooling(text: string): Record<string, number>;
export declare function parseBattery(text: string): BatteryReading;
export declare function parseWakefulness(text: string): string | null;
export declare function parseKeyguardShowing(text: string): boolean | null;
