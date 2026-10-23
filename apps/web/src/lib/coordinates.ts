/** Whether typed text is a number within `-limit` to `limit` (90 for a latitude, 180 for a longitude). */
export function isCoordinate(text: string, limit: number): boolean {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Whether the person typed anything into a pin's two fields. */
export const pinTyped = (lat: string, lng: string): boolean =>
  lat.trim() !== "" || lng.trim() !== "";

/** A pin is both numbers in range or neither (an untyped pin is fine: it means no pin). */
export const pinIsValid = (lat: string, lng: string): boolean =>
  !pinTyped(lat, lng) || (isCoordinate(lat, 90) && isCoordinate(lng, 180));

/** Whether typed text is a whole number of metres from `min` to `max`. */
export function isRadius(text: string, min: number, max: number): boolean {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= min && value <= max;
}
