/** The tries a refused code answer says are left; anything but a finite number reads as none. */
export function attemptsLeftOf(details: Readonly<Record<string, unknown>>): number {
  const left = details["attemptsLeft"];
  return typeof left === "number" && Number.isFinite(left) ? left : 0;
}
