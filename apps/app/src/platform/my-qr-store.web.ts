/**
 * Where My QR keeps its token in the browser (T-803): in memory only. `expo-secure-store` has no web build, and a token
 * never goes in web storage (SECURITY.md, T-111), so a reload fetches a new one.
 */
let held: string | null = null;

export const myQrStore = {
  read: (): Promise<string | null> => Promise.resolve(held),
  write: (token: string): Promise<void> => {
    held = token;
    return Promise.resolve();
  },
};
