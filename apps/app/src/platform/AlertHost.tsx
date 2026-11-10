/**
 * The in-app dialog host (T-803): nothing on a phone, where `Alert.alert` is the system's own dialog. The browser's
 * version is `AlertHost.web.tsx`, which Metro picks for the web build.
 */
export function AlertHost() {
  return null;
}
