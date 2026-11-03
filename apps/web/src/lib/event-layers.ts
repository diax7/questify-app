import { eventLayersSchema, type EventLayerRow, type EventLayers } from "@questify/shared";

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readEventLayers(body: unknown): EventLayers | undefined {
  const parsed = eventLayersSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** Whether the owner is offered a switch for the feature: listed (the platform leaves it on) and not an add-on. */
export function isSwitchListed(layers: EventLayers | null, key: string): boolean {
  return layers?.features.some((row) => row.key === key && !row.addOn) === true;
}

/** The one add-on's row, or undefined when the platform keeps it off for this organizer (it is then not shown at all). */
export function addOnRow(layers: EventLayers | null, key: string): EventLayerRow | undefined {
  return layers?.features.find((row) => row.key === key && row.addOn);
}

/** The add-ons the owner sees (the platform leaves them on), each locked or unlocked, in key order. */
export function addOnRows(layers: EventLayers | null): readonly EventLayerRow[] {
  return layers?.features.filter((row) => row.addOn) ?? [];
}
