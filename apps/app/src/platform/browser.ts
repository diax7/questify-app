/**
 * The little of the browser the web shims touch, typed here because the app compiles without the DOM library. Every
 * member is optional: a native bundle, a test and an old browser simply do not have them.
 */
export type BrowserGlobals = Readonly<{
  alert?: (text: string) => void;
  confirm?: (text: string) => boolean;
  navigator?: Readonly<{
    share?: (data: Readonly<{ text?: string; url?: string; title?: string }>) => Promise<void>;
  }>;
  location?: Readonly<{ reload: () => void }>;
  document?: Readonly<{
    documentElement: { dir: string; lang: string };
    createElement: (tag: "a") => {
      href: string;
      download: string;
      click: () => void;
      remove: () => void;
      style: { display: string };
    };
    body: { appendChild: (node: unknown) => void };
  }>;
  localStorage?: Readonly<{
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  }>;
  Blob?: new (parts: string[], options: Readonly<{ type: string }>) => unknown;
  URL?: Readonly<{
    createObjectURL: (blob: unknown) => string;
    revokeObjectURL: (url: string) => void;
  }>;
}>;

/** The browser's globals, or an object with none of them off the web. */
export const browser = (): BrowserGlobals => globalThis as unknown as BrowserGlobals;
