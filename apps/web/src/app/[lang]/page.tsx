import { notFound, redirect } from "next/navigation";
import { isLanguage, isolate, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import { AppShell } from "#src/ui/Shell.tsx";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Notice } from "#src/ui/Feedback.tsx";
import { Row, Rows, Section } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

/** The signed-in home: who you are and the organizers you belong to. The dashboard grows from here (T-101). */
export default async function HomePage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const staff = await currentStaff();
  if (staff.kind === "signed_out") {
    redirect(`/${lang}/sign-in${staff.ended ? "?ended=1" : ""}`);
  }
  if (staff.kind === "unavailable") {
    return (
      <AppShell language={lang} path="" signedIn={false}>
        <Notice tone="danger" role="alert">
          {t("error.generic")}
        </Notice>
        <ButtonLink variant="primary" href={`/${lang}`}>
          {t("common.retry")}
        </ButtonLink>
      </AppShell>
    );
  }
  const { me } = staff;
  return (
    <AppShell language={lang} path="" signedIn>
      <PageHeader
        title={t("nav.home")}
        description={t("staff.signedInAs", { email: isolate(me.email) })}
        actions={
          me.isAdmin ? (
            <ButtonLink variant="secondary" href={`/${lang}/console`}>
              {t("console.title")}
            </ButtonLink>
          ) : undefined
        }
      />
      <Section
        title={t("staff.organizers")}
        actions={
          <ButtonLink variant="primary" href={`/${lang}/organizers/new`}>
            {t("staff.newOrganizer")}
          </ButtonLink>
        }
      >
        {me.memberships.length === 0 ? (
          <EmptyState>{t("staff.noOrganizers")}</EmptyState>
        ) : (
          <Rows>
            {me.memberships.map((membership) => (
              <Row
                key={membership.organizerId}
                main={
                  <span>
                    {membership.organizerName} <Badge>{t(`staff.role.${membership.role}`)}</Badge>
                  </span>
                }
              >
                <ButtonLink size="sm" href={`/${lang}/organizers/${membership.organizerId}/events`}>
                  {t("events.title")}
                </ButtonLink>
                <ButtonLink size="sm" href={`/${lang}/organizers/${membership.organizerId}/team`}>
                  {t("staff.team")}
                </ButtonLink>
              </Row>
            ))}
          </Rows>
        )}
      </Section>
    </AppShell>
  );
}
