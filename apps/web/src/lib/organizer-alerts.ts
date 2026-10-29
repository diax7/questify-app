import {
  ORGANIZER_ALERT_TYPES,
  organizerAlertSwitchesSchema,
  type MessageKey,
  type OrganizerAlertSwitches,
  type OrganizerAlertType,
} from "@questify/shared";

/** The words of each alert type on the team page (T-503, FR-1727). */
export const ALERT_LABELS: Readonly<Record<OrganizerAlertType, MessageKey>> = {
  activated: "alerts.type.activated",
  stock_low: "alerts.type.stockLow",
  codes_low: "alerts.type.codesLow",
  new_flags: "alerts.type.newFlags",
  content_unpublished: "alerts.type.contentUnpublished",
  support_access: "alerts.type.supportAccess",
  size_limit: "alerts.type.sizeLimit",
};

/** The types in the order the page lists them. */
export const ALERT_ORDER: readonly OrganizerAlertType[] = ORGANIZER_ALERT_TYPES;

/** The member's switches from an API answer, or undefined when the answer is not exactly the seven booleans. */
export function readAlertSwitches(body: unknown): OrganizerAlertSwitches | undefined {
  const parsed = organizerAlertSwitchesSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The switches with one type set; the page sends the whole set on every change. */
export const withAlertSwitch = (
  switches: OrganizerAlertSwitches,
  type: OrganizerAlertType,
  on: boolean,
): OrganizerAlertSwitches => ({ ...switches, [type]: on });
