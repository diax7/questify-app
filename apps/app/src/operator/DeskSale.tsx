import { formatNumber, termFor, type Word } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  CAN_TEXT,
  OFFER_POLL_MS,
  saleEndKey,
  saleOutcome,
  type DeskInfo,
  type Found,
  type SaleList,
  type SaleOutcome,
  type SaleReward,
} from "#src/operator/desk.ts";
import {
  fetchSaleRewards,
  offerSaleAtDesk,
  pollSale,
  withdrawSaleAtDesk,
} from "#src/operator/operator-api.ts";

type Failure = Readonly<{ kind: string; message?: { ar: string; en: string } | null }>;

/** The sale on screen: the reward offered, and where it stands after the desk's last poll. */
type Shown = Readonly<{
  saleId: string;
  reward: SaleReward;
  justBought: boolean;
  outcome: SaleOutcome;
  reason: string | null;
}>;

/**
 * The offer, the wait for the player's Pay (polled every 2 seconds until it ends) and Withdraw. One key per reward
 * until the server answers, so a lost reply is retried, never doubled. Each offer is a generation: a wait from an
 * earlier one, or from a screen the desk left, stops at its next step.
 */
function useSale({
  eventId,
  code,
  settle,
  reload,
  setList,
}: Readonly<{
  eventId: string;
  code: string;
  settle: (answer: Failure) => void;
  reload: () => Promise<void>;
  setList: (list: SaleList) => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const keys = useRef(new Map<string, string>());
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const waitForPay = async (saleId: string) => {
    const started = generation.current;
    let outcome: SaleOutcome = "waiting";
    let reason: string | null = null;
    while (outcome === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, OFFER_POLL_MS));
      if (generation.current !== started) {
        return;
      }
      const poll = await pollSale(api.session, saleId);
      if (generation.current !== started) {
        return;
      }
      if (poll.kind !== "poll") {
        settle(poll);
        return;
      }
      outcome = saleOutcome(poll);
      reason = poll.reason;
    }
    setShown((current) => (current === null ? current : { ...current, outcome, reason }));
    await reload();
  };

  const offer = async (reward: SaleReward) => {
    setBusy(true);
    const key = keys.current.get(reward.id) ?? randomUuid();
    keys.current.set(reward.id, key);
    const answer = await offerSaleAtDesk(api.session, { eventId, code, rewardId: reward.id }, key);
    if (answer.kind !== "network") {
      keys.current.delete(reward.id);
    }
    setBusy(false);
    if (answer.kind === "list") {
      setList(answer.list);
      return;
    }
    if (answer.kind !== "offered") {
      settle(answer);
      return;
    }
    generation.current += 1;
    setShown({
      saleId: answer.saleId,
      reward,
      justBought: answer.justBought,
      outcome: "waiting",
      reason: null,
    });
    await waitForPay(answer.saleId);
  };

  const withdraw = async (saleId: string) => {
    setBusy(true);
    const answer = await withdrawSaleAtDesk(api.session, saleId);
    setBusy(false);
    if (answer.kind !== "withdrawn") {
      settle(answer);
      return;
    }
    generation.current += 1;
    setShown((current) =>
      current === null ? current : { ...current, outcome: "withdrawn", reason: null },
    );
    await reload();
  };

  return { busy, shown, offer, withdraw };
}

/** One reward the desk can sell: its price, and Offer or why it cannot be offered now (never the balance). */
function SaleRow({
  reward,
  currency,
  disabled,
  onOffer,
}: Readonly<{ reward: SaleReward; currency: Word; disabled: boolean; onOffer: () => void }>) {
  const { t, language } = useI18n();
  return (
    <View style={{ gap: 4 }}>
      <AppText variant="label">{textIn(reward.name, language)}</AppText>
      <AppText muted>
        {t("operator.desk.salePrice", {
          price: formatNumber(reward.price, language),
          currency: termFor(currency, language, reward.price),
        })}
      </AppText>
      {reward.can === "ok" ? (
        <Button label={t("operator.desk.offer")} disabled={disabled} onPress={onOffer} />
      ) : (
        <AppText muted>{t(CAN_TEXT[reward.can])}</AppText>
      )}
    </View>
  );
}

/** The offer waiting for the player's Pay, with Withdraw, or how it ended. */
function SaleState({
  shown,
  player,
  busy,
  onWithdraw,
}: Readonly<{ shown: Shown; player: string; busy: boolean; onWithdraw: () => void }>) {
  const { t, language } = useI18n();
  const name = textIn(shown.reward.name, language);
  return (
    <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
      <AppText variant="label">{name}</AppText>
      {shown.justBought ? (
        <AppText accessibilityRole="alert">{t("operator.desk.justBought", { player })}</AppText>
      ) : null}
      {shown.outcome === "waiting" ? (
        <>
          <AppText>{t("operator.desk.saleWaiting", { player })}</AppText>
          <Button
            kind="quiet"
            label={t("operator.desk.withdraw")}
            disabled={busy}
            onPress={onWithdraw}
          />
        </>
      ) : (
        <AppText accessibilityRole="alert">
          {t(saleEndKey(shown.outcome, shown.reason), { player })}
        </AppText>
      )}
    </View>
  );
}

/**
 * "Sell from the shop" (T-612, FR-1834, ADR-397): shown after a My QR scan while the event's reservation is Off and
 * the shop on. The desk offers one reward; the player pays on their own phone (ADR-137), which takes the price and
 * hands it over in one step. The desk never sees the player's balance, only whether they can buy (Q-364 g).
 */
export function DeskSale({
  eventId,
  code,
  player,
  currency,
  settle,
}: Readonly<{
  eventId: string;
  code: string;
  player: string;
  currency: Word;
  settle: (answer: Failure) => void;
}>) {
  const { t } = useI18n();
  const [list, setList] = useState<SaleList | undefined>(undefined);
  const reload = useCallback(async () => {
    const answer = await fetchSaleRewards(api.session, eventId, code);
    if (answer.kind === "list") {
      setList(answer.list);
    } else {
      settle(answer);
    }
  }, [eventId, code, settle]);
  const sale = useSale({ eventId, code, settle, reload, setList });
  useEffect(() => {
    void reload();
  }, [reload]);
  const waiting = sale.shown?.outcome === "waiting";
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title">{t("operator.desk.sell")}</AppText>
      {sale.shown === null ? null : (
        <SaleState
          shown={sale.shown}
          player={player}
          busy={sale.busy}
          onWithdraw={() => void sale.withdraw(sale.shown?.saleId ?? "")}
        />
      )}
      <SaleRows
        list={list}
        currency={currency}
        disabled={sale.busy || waiting}
        onOffer={(reward) => void sale.offer(reward)}
      />
    </View>
  );
}

/** The rewards the desk can sell now, or why there are none. */
function SaleRows({
  list,
  currency,
  disabled,
  onOffer,
}: Readonly<{
  list: SaleList | undefined;
  currency: Word;
  disabled: boolean;
  onOffer: (reward: SaleReward) => void;
}>) {
  const { t } = useI18n();
  if (list === undefined) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  if (list.kind === "refused") {
    return <AppText accessibilityRole="alert">{t(list.reason)}</AppText>;
  }
  if (list.rewards.length === 0) {
    return <AppText>{t("operator.desk.nothingToSell")}</AppText>;
  }
  return (
    <>
      {list.rewards.map((reward) => (
        <SaleRow
          key={reward.id}
          reward={reward}
          currency={currency}
          disabled={disabled}
          onOffer={() => onOffer(reward)}
        />
      ))}
    </>
  );
}

/**
 * Where "Sell from the shop" goes on the desk: only after a player is shown and while the desk sells (reservation Off and
 * the shop on). A player found by name or phone cannot be sold to: a sale needs My QR (Q-364 c).
 */
export function DeskSellPanel({
  shown,
  canHandOver,
  desk,
  eventId,
  code,
  currency,
  settle,
}: Readonly<{
  shown: Found | null;
  canHandOver: boolean;
  desk: DeskInfo | undefined;
  eventId: string;
  code: string | null;
  currency: Word;
  settle: (answer: Failure) => void;
}>) {
  const { t } = useI18n();
  if (shown === null || !canHandOver || desk?.sells !== true) {
    return null;
  }
  return code === null ? (
    <AppText muted>{t("operator.desk.sellNeedsQr")}</AppText>
  ) : (
    <DeskSale
      key={code}
      eventId={eventId}
      code={code}
      player={shown.player.username}
      currency={currency}
      settle={settle}
    />
  );
}
