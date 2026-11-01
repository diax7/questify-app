import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import {
  acceptHandover,
  countdown,
  declineHandover,
  fetchDeskItems,
  type DeskItemNow,
  type DeskSaleNow,
} from "#src/event/shop-api.ts";
import { DeskSaleCard } from "#src/event/DeskSaleCard.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { OFFER_POLL_MS } from "#src/operator/desk.ts";

/** My QR stops asking after this long without a live offer; "Check again" starts it once more. */
const WATCH_LIMIT_MS = 3 * 60_000;

/**
 * Accept and Not now on the desk's handover offer (ADR-137). One key per reservation until the server answers, so a lost
 * reply is retried, never doubled.
 */
function useHandoverAnswer(load: () => Promise<void>, setNote: (note: string) => void) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false);
  const acceptKey = useRef<{ id: string; key: string } | undefined>(undefined);

  const accept = async (item: DeskItemNow) => {
    setBusy(true);
    if (acceptKey.current?.id !== item.id) {
      acceptKey.current = { id: item.id, key: randomUuid() };
    }
    const answer = await acceptHandover(api.session, item.id, acceptKey.current.key);
    if (answer.kind !== "network") {
      acceptKey.current = undefined;
    }
    setBusy(false);
    if (answer.kind === "done") {
      setNote(t("myQr.offerDone", { name: textIn(item.name, language) }));
    } else if (answer.kind === "refused" && answer.problem !== null) {
      setNote(answer.problem[language]);
    } else {
      setNote(t("join.network"));
    }
    await load();
  };

  const decline = async (item: DeskItemNow) => {
    setBusy(true);
    await declineHandover(api.session, item.id);
    setBusy(false);
    await load();
  };

  return { busy, accept, decline };
}

/**
 * Under My QR (T-206): rewards ready at a desk with their countdown, the desk's offer to accept (ADR-137), and the
 * desk's offer to sell with Pay (T-612). It asks the server every 2 seconds only while the player holds a reward in an
 * event that uses desk offers, or is in an event whose desk sells, only while the app is in front, and for at most 3
 * minutes without an offer.
 */
export function DeskItems() {
  const { t, language } = useI18n();
  const [items, setItems] = useState<readonly DeskItemNow[]>([]);
  const [sales, setSales] = useState<readonly DeskSaleNow[]>([]);
  const [watch, setWatch] = useState(false);
  const [watchingSince, setWatchingSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState<string | null>(null);
  const [front, setFront] = useState(AppState.currentState === "active");

  const load = useCallback(async () => {
    const answer = await fetchDeskItems(api.session);
    if (answer.kind === "items") {
      setItems(answer.items);
      setSales(answer.sales);
      setWatch(answer.watch);
      if (answer.sales.length > 0 || answer.items.some((item) => item.state === "offered")) {
        setWatchingSince(Date.now());
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setWatchingSince(Date.now());
      void load();
    }, [load]),
  );

  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => setFront(state === "active"));
    return () => watcher.remove();
  }, []);

  const asking = watch && front && now - watchingSince < WATCH_LIMIT_MS;
  useEffect(() => {
    if (!asking) {
      return undefined;
    }
    const timer = setInterval(() => void load(), OFFER_POLL_MS);
    return () => clearInterval(timer);
  }, [asking, load]);

  // The countdowns tick on the phone; nothing is asked for them.
  useEffect(() => {
    if (items.length === 0 && sales.length === 0 && !watch) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [items.length, sales.length, watch]);

  const { busy, accept, decline } = useHandoverAnswer(load, setNote);
  const paid = async (said: string | null) => {
    setNote(said);
    await load();
  };

  const live = items.filter((item) => item.until !== null && Date.parse(item.until) > now);
  const liveSales = sales.filter((sale) => sale.until !== null && Date.parse(sale.until) > now);
  return (
    <View style={{ gap: 12, alignSelf: "stretch" }}>
      {note === null ? null : <AppText accessibilityRole="alert">{note}</AppText>}
      {liveSales.map((sale) => (
        <DeskSaleCard key={sale.id} sale={sale} now={now} onDone={paid} />
      ))}
      {live.map((item) =>
        item.state === "offered" ? (
          <View key={item.id} style={{ gap: 8 }} accessibilityLiveRegion="polite">
            <AppText variant="title">
              {t("myQr.offerTitle", { name: textIn(item.name, language) })}
            </AppText>
            <Button label={t("myQr.accept")} disabled={busy} onPress={() => void accept(item)} />
            <Button
              kind="quiet"
              label={t("operator.notNow")}
              disabled={busy}
              onPress={() => void decline(item)}
            />
          </View>
        ) : (
          <AppText key={item.id} variant="label">
            {t("myQr.collecting", {
              name: textIn(item.name, language),
              time: countdown(item.until, now),
            })}
          </AppText>
        ),
      )}
      {watch && !asking && front ? (
        <Button
          kind="quiet"
          label={t("myQr.checkAgain")}
          onPress={() => {
            setWatchingSince(Date.now());
            void load();
          }}
        />
      ) : null}
    </View>
  );
}
