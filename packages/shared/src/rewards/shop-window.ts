import { z } from "zod";

const instant = z.iso.datetime({ offset: true });

/**
 * The rewards shop's state (`shop_state`, ADR-048): not open before the event, open while it is live and for its days
 * after the end, then closed for good (ADR-336).
 */
export const SHOP_STATES = ["not_open", "open", "closed"] as const;
export type ShopState = (typeof SHOP_STATES)[number];

/**
 * Home's shop window (T-410, ADR-338): the state the shop shows this player, when it closes (null while the event has
 * no end), and the end of the prize desk's last window when that comes before the close: items and experiences stop
 * there, digital rewards stay until the close. Null on Home while the event's shop switch is off.
 */
export const shopWindowSchema = z.object({
  state: z.enum(SHOP_STATES),
  closesAt: instant.nullable(),
  deskEndsAt: instant.nullable(),
});
export type ShopWindow = z.infer<typeof shopWindowSchema>;
