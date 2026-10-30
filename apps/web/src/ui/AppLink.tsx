import Link from "next/link";
import type { ComponentProps } from "react";

export type AppLinkProps = Omit<ComponentProps<"a">, "href" | "ref"> & Readonly<{ href: string }>;

/**
 * A link to a page of this app: Next's `Link`, so the page changes in place with no document reload and the shell
 * stays put (T-599c). An address that leaves the app (another site, `questify://`, a fragment, `mailto:`) stays a plain
 * anchor. Nothing is prefetched: every page here reads the session and the API on the server, so a prefetch would
 * repeat that work for each link in view (and a prefetched language link would change the saved language). The kiosk
 * page must be opened by a full load, because its page headers (camera, WebAssembly) are the ones the document was
 * loaded with (ADR-245); the links to the device pages are plain anchors written where they are used.
 */
export function AppLink({ href, ...props }: AppLinkProps) {
  if (!href.startsWith("/") || href.startsWith("//")) {
    return <a href={href} {...props} />;
  }
  // React's anchor props allow an explicit `undefined`, Link's do not (exactOptionalPropertyTypes); the values are the same.
  return (
    <Link href={href} prefetch={false} {...(props as Omit<ComponentProps<typeof Link>, "href">)} />
  );
}
