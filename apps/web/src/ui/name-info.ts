import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The info button a labelled part passes on, told what it sits beside: the part names it "More information: label". Anything
 * else passes through; a label that is not plain text leaves the plain name. It is no client module, so a server
 * component (a page header, a section) can call it.
 */
export function nameInfo(info: ReactNode, subject: ReactNode): ReactNode {
  if (typeof subject !== "string" || !isValidElement(info)) {
    return info;
  }
  return cloneElement(info as ReactElement<{ subject?: string }>, { subject });
}
