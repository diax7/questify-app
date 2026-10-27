import { notFound } from "next/navigation";
import { ConsoleInvitation } from "#src/components/ConsoleInvitation.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";
import { isCampaignId } from "#src/lib/console-invitations.ts";

type Props = Readonly<{ params: Promise<{ lang: string; campaignId: string }> }>;

/** One invitation request of Questify's queue (T-409b). Platform admins only; any other id reads as not found. */
export default async function ConsoleInvitationPage({ params }: Props) {
  const { lang, campaignId } = await params;
  const page = await consolePage(lang);
  if (!isCampaignId(campaignId)) {
    notFound();
  }
  return (
    <ConsoleShell page={page} path={`/console/invitations/${campaignId}`}>
      <ConsoleInvitation key={campaignId} language={page.language} campaignId={campaignId} />
    </ConsoleShell>
  );
}
