/**
 * Dissolved-oxygen percent-saturation derivation: García & Gordon (1992),
 * Benson–Krause combined fit, evaluated at P = 1 atm (sea-level reference,
 * no elevation correction). Equivalent to
 * `LakeMetabolizer::o2.at.sat(method = "garcia-benson")`.
 *
 * Scope:
 *   - DO saturation in the observation data is a native optical-sensor output
 *     (YSI EXO2 `EXODOsat_percent`, PME RDO/MiniDOT `*DOsat_percent`), so the
 *     sensor channel reads `DOsat_percent_mean` directly and does not call this
 *     module.
 *   - The FLARE GLM-AED forecast publishes DO (mg/L) and temperature (°C) but no
 *     saturation variable, so the forecast channel derives %sat here. That is the
 *     only consumer of this module.
 *
 * Validation against 10,423 VERA records: García–Benson at 1 atm reproduced the
 * native sensor %sat with MAE 0.07 %sat at FCR 9 m (0.03–0.12 across FCR depths
 * and the BVR surface). A pressure-reference sweep confirmed 1 atm (correcting for
 * the 506 m elevation gives MAE 5.19). BVR 6 m showed an isolated −6.3 % offset
 * traced to an upstream sensor/temperature-pairing issue, not the formula.
 *
 * Example: at 20 °C in freshwater, C* = 9.09 mg/L (textbook value about 9.08), so
 * %sat(9.09 mg/L, 20 °C) = 100.0 %.
 */

// García & Gordon (1992) Benson–Krause volumetric (mL/L) coefficients,
// freshwater (salinity S = 0, so the salinity B/C terms drop out).
const GB_A = [2.00907, 3.22014, 4.05010, 4.94457, -0.256847, 3.88767] as const;

// O2 unit conversion: 1 mL O2 (STP) = 1.42905 mg O2.
const ML_PER_L_TO_MG_PER_L = 1.42905;

/**
 * Equilibrium DO solubility (mg/L) in freshwater at 1 atm for a given water
 * temperature (°C). This is the 100 %-saturation concentration - the
 * denominator in the percent-saturation calculation.
 */
export function oxygenSolubilityMgL(tempC: number): number {
  // Scaled temperature Ts = ln[(298.15 − T) / (273.15 + T)].
  const ts = Math.log((298.15 - tempC) / (273.15 + tempC));
  let lnC = 0;
  for (let i = 0; i < GB_A.length; i++) lnC += GB_A[i] * ts ** i;
  return Math.exp(lnC) * ML_PER_L_TO_MG_PER_L;
}

/**
 * Derive DO percent saturation from a DO concentration (mg/L) and water
 * temperature (°C), García–Benson @1 atm. Returns `null` for non-finite inputs
 * or a non-physical temperature that would make the solubility undefined.
 *
 * Used by the forecast channel only (sensor channel reads native
 * `DOsat_percent_mean`).
 */
export function doPercentSaturation(doMgL: number, tempC: number): number | null {
  if (!Number.isFinite(doMgL) || !Number.isFinite(tempC)) return null;
  // The fit is valid for about −2 to 40 °C; only temperatures outside −10 to 80 °C
  // return null.
  if (tempC <= -10 || tempC >= 80) return null;
  const sat = oxygenSolubilityMgL(tempC);
  if (!Number.isFinite(sat) || sat <= 0) return null;
  return (doMgL / sat) * 100;
}
