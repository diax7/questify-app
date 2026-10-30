import type { MessageKey } from "@questify/shared";
import { InfoTip } from "#src/ui/InfoTip.tsx";

/**
 * The info button for one text of the page (ADR-370), named in the page's language: `info={infoTip(t, "key")}`. It is
 * the whole call a field, switch, section or page header makes; the button itself is `InfoTip`.
 */
export function infoTip(t: (key: MessageKey) => string, key: MessageKey) {
  return <InfoTip label={t("common.info")}>{t(key)}</InfoTip>;
}
