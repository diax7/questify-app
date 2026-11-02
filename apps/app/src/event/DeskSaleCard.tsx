import { DEFAULT_TERMS, formatNumber, termFor } from "@questify/shared";
import { useRef, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import {
  acceptDeskSale,
  countdown,
  declineDeskSale,
  type DeskSaleNow,
} from "#src/event/shop-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/**
 * The prize desk's offer to sell (T-612, FR-1834, ADR-137): the reward, its price, the balance after, the desk's place,
 * the shop's rules before a first redemption, and the countdown. Pay is the player's own consent: the price leaves the
 * balance and the reward is handed over in one step. One key per sale until the server answers, so a lost reply is
 * retried, never paid twice. A refused Pay reads as the server's own sentence.
 */
export function DeskSaleCard({
  sale,
  now,
  onDone,
}: Readonly<{ sale: DeskSaleNow; now: number; onDone: (note: string | null) => Promise<void> }>) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false);
  const payKey = useRef<string | undefined>(undefined);
  const name = textIn(sale.name, language);
  // My QR is not inside one event, so the price is named with the default currency word.
  const amount = (value: number) =>
    `${formatNumber(value, language)} ${termFor(DEFAULT_TERMS.currency, language, value)}`;

  const pay = async () => {
    setBusy(true);
    payKey.current ??= randomUuid();
    const answer = await acceptDeskSale(api.session, sale.id, payKey.current);
    if (answer.kind !== "network") {
      payKey.current = undefined;
    }
    setBusy(false);
    if (answer.kind === "done") {
      await onDone(t("myQr.saleDone", { name }));
    } else if (answer.kind === "refused" && answer.problem !== null) {
      await onDone(answer.problem[language]);
    } else {
      await onDone(t("join.network"));
    }
  };

  const decline = async () => {
    setBusy(true);
    const answer = await declineDeskSale(api.session, sale.id);
    setBusy(false);
    await onDone(answer.kind === "network" ? t("join.network") : null);
  };

  return (
    <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
      <AppText variant="title">{t("myQr.saleTitle", { name, price: amount(sale.price) })}</AppText>
      {sale.justBought ? <AppText accessibilityRole="alert">{t("myQr.justBought")}</AppText> : null}
      <AppText>{t("myQr.saleBalance", { balance: amount(sale.balanceAfter) })}</AppText>
      {sale.desk === null ? null : (
        <AppText muted>{t("myQr.saleDesk", { place: textIn(sale.desk, language) })}</AppText>
      )}
      {sale.rules === null ? null : (
        <View style={{ gap: 4 }}>
          <AppText variant="label">{t("myQr.saleRules")}</AppText>
          <AppText muted>{textIn(sale.rules, language)}</AppText>
        </View>
      )}
      <AppText muted>{t("myQr.saleLeft", { time: countdown(sale.until, now) })}</AppText>
      <Button label={t("myQr.pay")} disabled={busy} onPress={() => void pay()} />
      <Button
        kind="quiet"
        label={t("operator.notNow")}
        disabled={busy}
        onPress={() => void decline()}
      />
    </View>
  );
}
