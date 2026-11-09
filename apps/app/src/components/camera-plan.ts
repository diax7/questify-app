/** What the camera area of a scanner shows: the permission wait, the permission card, or the live camera. */
export type CameraPlan = Readonly<{
  /** The permission is still being read. */
  loading: boolean;
  /** The permission is missing: its card, and whether the system can still ask. */
  ask: Readonly<{ canAskAgain: boolean }> | null;
  /** The live camera. */
  camera: boolean;
}>;

/**
 * The camera area of a scanner. `present` is whether the screen has what it scans for at all (a station), and
 * `usable` whether the camera may run now (in front, not failed to mount, and for the quest scanner not mid-scan).
 */
export function cameraPlan(
  permission: Readonly<{ granted: boolean; canAskAgain: boolean }> | null,
  present: boolean,
  usable: boolean,
): CameraPlan {
  const granted = permission?.granted === true;
  return {
    loading: present && permission === null,
    ask:
      present && permission !== null && !granted ? { canAskAgain: permission.canAskAgain } : null,
    camera: present && granted && usable,
  };
}
