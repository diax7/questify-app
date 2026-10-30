import {
  memberSponsorsSchema,
  type MemberSponsor,
  type MemberSponsors,
  type SponsorTagKind,
} from "@questify/shared";
import type { Session } from "#src/api/session.ts";

type Requester = Pick<Session, "request">;

export type SponsorsRead =
  | Readonly<{ kind: "sponsors"; data: MemberSponsors }>
  | Readonly<{ kind: "signed_out" | "network" }>;

/** The event's sponsors and the tags on what the player may see (`GET /v1/events/{id}/sponsors`, FR-1303). */
export async function fetchSponsors(session: Requester, eventId: string): Promise<SponsorsRead> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/sponsors`,
  });
  if (answer.kind === "signed_out") return { kind: "signed_out" };
  const parsed = answer.kind === "ok" ? memberSponsorsSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? { kind: "sponsors", data: parsed.data } : { kind: "network" };
}

/** What the screens ask of the sponsors: who presents an item, and which quests a sponsor presents. */
export type SponsorLookup = Readonly<{
  /** False until a read has answered for this event: an unknown sponsor is then still loading, not gone. */
  read: boolean;
  sponsors: readonly MemberSponsor[];
  of: (kind: SponsorTagKind, targetId: string) => MemberSponsor | undefined;
  byId: (id: string) => MemberSponsor | undefined;
}>;

/** Before the read, and after a failed first read. */
export const NO_SPONSORS: SponsorLookup = {
  read: false,
  sponsors: [],
  of: () => undefined,
  byId: () => undefined,
};

/** An event whose read answered with no sponsors. */
const NONE_TAGGED: SponsorLookup = { ...NO_SPONSORS, read: true };

export function lookupOf(data: MemberSponsors | undefined): SponsorLookup {
  if (data === undefined) return NO_SPONSORS;
  if (data.sponsors.length === 0) return NONE_TAGGED;
  const byId = new Map(data.sponsors.map((sponsor) => [sponsor.id, sponsor]));
  const tagged = new Map(
    data.tags.map((tag) => [`${tag.kind}:${tag.targetId}`, byId.get(tag.sponsorId)] as const),
  );
  return {
    read: true,
    sponsors: data.sponsors,
    of: (kind, targetId) => tagged.get(`${kind}:${targetId}`),
    byId: (id) => byId.get(id),
  };
}

type QuestsOf = Readonly<{ id: string; quests: readonly Readonly<{ id: string }>[] }>;

/**
 * The categories narrowed to one sponsor's quests (FR-1307): a quest tagged to the sponsor, and every quest of a
 * category tagged to it. A category left with no quest is dropped.
 */
export function narrowTo<Category extends QuestsOf>(
  categories: readonly Category[],
  sponsorId: string,
  lookup: SponsorLookup,
): Category[] {
  const presents = (kind: SponsorTagKind, id: string) => lookup.of(kind, id)?.id === sponsorId;
  return categories
    .map((category) => ({
      ...category,
      quests: category.quests.filter(
        (quest) => presents("category", category.id) || presents("quest", quest.id),
      ),
    }))
    .filter((category) => category.quests.length > 0);
}
