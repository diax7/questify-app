import { whatsappLink, type SupportContact } from "@questify/shared";
import { notFound } from "next/navigation";
import { webConfig } from "#src/lib/config.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { fetchSupportContact } from "#src/lib/legal-api.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import styles from "#src/components/contact.module.css";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The ways to reach support that are set, in the order the page lists them; a number reads left to right. */
function waysToReach(contact: SupportContact) {
  return [
    contact.whatsapp === null
      ? null
      : {
          key: "whatsapp",
          label: "contact.whatsapp" as const,
          text: contact.whatsapp,
          href: whatsappLink(contact.whatsapp),
        },
    contact.phone === null
      ? null
      : {
          key: "phone",
          label: "contact.phone" as const,
          text: contact.phone,
          href: `tel:${contact.phone}`,
        },
    contact.email === null
      ? null
      : {
          key: "email",
          label: "contact.email" as const,
          text: contact.email,
          href: `mailto:${contact.email}`,
        },
  ].filter((way) => way !== null);
}

/**
 * The contact page the app's Settings opens (FR-1707): the WhatsApp number, phone number and email an admin set in the
 * console (T-706, FR-1731), only those that are set. Until one is, or when the API does not answer, it says the details
 * are being prepared. The company's address and registration are a release gate in STORE_COMPLIANCE §4 (T-807).
 */
export default async function ContactPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const contact = await fetchSupportContact({ apiOrigin: webConfig().apiOrigin });
  const ways = contact === undefined ? [] : waysToReach(contact);
  return (
    <AppShell area="public" language={lang} path="/contact" signedIn={false} narrow>
      <Card as="article">
        <PageHeader title={t("contact.title")} />
        {ways.length === 0 ? (
          <p>{t("contact.pending")}</p>
        ) : (
          <ul data-testid="contact-ways">
            {ways.map((way) => (
              <li key={way.key} className={styles["way"]}>
                <span>{t(way.label)}</span>
                <TextLink href={way.href} dir="ltr">
                  {way.text}
                </TextLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
