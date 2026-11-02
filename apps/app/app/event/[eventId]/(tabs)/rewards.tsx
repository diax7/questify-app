import {
  MESSAGES,
  formatEventTime,
  formatNumber,
  termFor,
  type Language,
  type LocalizedText,
  type MemberSponsor,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { DeskLine } from "#src/event/DeskLine.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { PresentedBy } from "#src/event/PresentedBy.tsx";
import { ShopClosedPanel } from "#src/event/ShopClosedPanel.tsx";
import { unlockLine } from "#src/event/unlock.ts";
import { useSponsors } from "#src/event/useSponsors.ts";
import {
  cancelRedemption,
  fetchShop,
  inSection,
  minutesLeft,
  reserveReward,
  rewardAction,
  sectionsOf,
  setGoal,
  startCollect,
  type MyRedemption,
  type RewardAction,
  type ShopAnswer,
  type ShopCallAnswer,
  type ShopReward,
  type ShopView,
} from "#src/event/shop-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { ReportButton } from "#src/questify/ReportButton.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** Why a reward cannot be redeemed now, in words; Redeem itself has its own button. */
const ACTION_TEXT: Readonly<Record<Exclude<RewardAction, "redeem">, MessageKey>> = {
  sold_out: "shop.soldOut",
  not_yet: "shop.notYet",
  ended: "shop.ended",
  limit: "shop.limit",
  too_dear: "shop.tooDear",
  shop_closed: "shop.closed",
  desk_finished: "shop.deskFinished",
  community_locked: "shop.communityLocked",
  at_desk: "shop.atDesk",
};

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(["featured", "merch", "food", "experiences"]);

const OFFLINE = MESSAGES["signIn.offline"];

function Tags({ reward }: Readonly<{ reward: ShopReward }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const tags = (["new", "limited", "popular"] as const).filter((tag) => reward.tags[tag]);
  return tags.length === 0 ? null : (
    <View style={styles.row}>
      {tags.map((tag) => (
        <AppText key={tag} variant="label" style={styles.tag}>
          {t(`rewards.tag.${tag}`)}
        </AppText>
      ))}
    </View>
  );
}

/** What a reward shows above its action: the name, tags, sponsor, description, price and stock. */
function RewardSummary({
  reward,
  sponsor,
  pinned,
  compact,
}: Readonly<{
  reward: ShopReward;
  sponsor: MemberSponsor | undefined;
  pinned: boolean;
  compact: boolean;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const description = textIn(reward.description, language);
  const nameLines = compact ? 2 : undefined;
  const descriptionLines = compact ? 3 : undefined;
  return (
    <View style={styles.tileBody}>
      {pinned ? <AppText variant="label">{t("goal.title")}</AppText> : null}
      <AppText variant={compact ? "label" : "title"} numberOfLines={nameLines}>
        {textIn(reward.name, language)}
      </AppText>
      <Tags reward={reward} />
      <PresentedBy sponsor={sponsor} />
      {description === "" ? null : (
        <AppText numberOfLines={descriptionLines}>{description}</AppText>
      )}
      <View style={styles.row}>
        <Amount
          amount={formatNumber(reward.price, language)}
          form={compact ? "compact" : "labelled"}
          variant="label"
        />
        <AppText muted>
          {reward.stockLeft > 0
            ? t("shop.left", { count: formatNumber(reward.stockLeft, language) })
            : t("shop.soldOut")}
        </AppText>
      </View>
    </View>
  );
}

/** Redeem, or why the reward cannot be redeemed now. */
function RewardAction({
  reward,
  view,
  onRedeem,
}: Readonly<{ reward: ShopReward; view: ShopView; onRedeem: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const action = rewardAction(reward, view, Date.now());
  if (action === "redeem") {
    return <Button label={t("shop.redeem")} onPress={onRedeem} />;
  }
  // Reservation is off (FR-1834): no Reserve here; the desk offers it after a My QR scan and the player pays there.
  if (action === "at_desk") {
    return (
      <View style={{ gap: 4 }}>
        <AppText variant="label">{t("shop.atDesk")}</AppText>
        <AppText muted>{t("shop.atDeskHint")}</AppText>
        <DeskLine desk={view.shop.desk} />
      </View>
    );
  }
  // A reward a community goal still locks names the goal's numbers instead of a price button (T-306c).
  const unlock =
    action === "community_locked" && reward.communityLock !== null
      ? unlockLine(reward.communityLock, language, view.shop.desk.timeZone)
      : null;
  return (
    <AppText muted accessibilityRole="text">
      {unlock === null
        ? t(ACTION_TEXT[action], { currency: termFor(terms.currency, language) })
        : t(unlock.key, unlock.values)}
    </AppText>
  );
}

/**
 * One reward. In the shop's grid (`compact`, FR-1833) it is one of two cards a row: the name keeps two lines at most, the
 * description three, and the action sits at the bottom, so the cards of a row line up.
 */
function RewardCard({
  reward,
  sponsor,
  view,
  busy,
  compact,
  onRedeem,
  onPin,
}: Readonly<{
  reward: ShopReward;
  sponsor: MemberSponsor | undefined;
  view: ShopView;
  busy: boolean;
  compact: boolean;
  onRedeem: () => void;
  /** Pins this reward as the goal, or unpins it when it is the goal (FR-517). */
  onPin: () => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const pinned = view.goalRewardId === reward.id;
  return (
    <View style={[styles.card, compact && styles.tile, pinned && styles.chosen]}>
      <RewardSummary reward={reward} sponsor={sponsor} pinned={pinned} compact={compact} />
      <View style={styles.tileBody}>
        <RewardAction reward={reward} view={view} onRedeem={onRedeem} />
        <Button
          kind="quiet"
          label={t(pinned ? "goal.unpin" : "goal.pin")}
          disabled={busy}
          onPress={onPin}
        />
        <ReportButton subject={{ kind: "reward", targetId: reward.id }} />
      </View>
    </View>
  );
}

/** A finished reservation's last word: picked up, confirmed, cancelled, expired or ended. */
function endedKey(mine: MyRedemption): MessageKey {
  switch (mine.status) {
    case "handed_over":
      return mine.kind === "experience" ? "shop.status.confirmed" : "shop.status.handedOver";
    case "cancelled":
      return "shop.status.cancelled";
    case "expired":
      return "shop.status.expired";
    default:
      return "shop.status.other";
  }
}

/**
 * How a reservation reaches the desk (ADR-137, ADR-150): with collect first the player taps Collect, which opens My QR
 * ready for 5 minutes; with desk offers the player shows My QR and accepts there.
 */
function PickUp({
  mine,
  view,
  busy,
  onCollect,
}: Readonly<{
  mine: MyRedemption;
  view: ShopView;
  busy: boolean;
  onCollect: (id: string) => void;
}>) {
  const { t } = useI18n();
  if (view.shop.desk.confirm === "desk_offer") {
    return <AppText muted>{t("shop.offerHint")}</AppText>;
  }
  const collecting = mine.collectUntil !== null && Date.parse(mine.collectUntil) > Date.now();
  return (
    <>
      <AppText muted>{t(collecting ? "shop.collecting" : "shop.collectHint")}</AppText>
      <Button
        label={t("shop.collect")}
        disabled={busy || view.shop.desk.state !== "open"}
        onPress={() => onCollect(mine.id)}
      />
    </>
  );
}

function MyReservations({
  view,
  busy,
  onCancel,
  onCollect,
}: Readonly<{
  view: ShopView;
  busy: boolean;
  onCancel: (id: string) => void;
  onCollect: (id: string) => void;
}>) {
  const { t, language } = useI18n();
  const { eventId, helpOn } = useEvent();
  const styles = useThemedStyles(makeStyles);
  if (view.redemptions.length === 0) {
    return null;
  }
  const waiting = view.redemptions.some((mine) => mine.status === "reserved");
  return (
    <>
      <AppText variant="title">{t("shop.mine")}</AppText>
      {waiting ? <DeskLine desk={view.shop.desk} /> : null}
      {view.redemptions.map((mine) => (
        <View key={mine.id} style={styles.card}>
          <AppText variant="label">{textIn(mine.name, language)}</AppText>
          {mine.rank === null ? null : (
            <AppText muted>
              {t("win.rankPrize", { rank: formatNumber(mine.rank, language) })}
            </AppText>
          )}
          {mine.source === "quest" ? <AppText muted>{t("win.questReward")}</AppText> : null}
          {mine.status === "delivered" ? (
            mine.code === null ? (
              <AppText muted>
                {t(mine.codeUnavailable ? "shop.codeUnavailable" : "shop.status.other")}
              </AppText>
            ) : (
              <>
                <CodeText code={mine.code} />
                {mine.testCode ? <AppText muted>{t("rehearsal.testCode")}</AppText> : null}
              </>
            )
          ) : mine.status === "reserved" ? (
            <>
              <AppText>
                {mine.source === "shop"
                  ? t("shop.minutesLeft", {
                      minutes: formatNumber(minutesLeft(mine.reservedUntil, Date.now()), language),
                    })
                  : t("win.collectBy", {
                      deadline: formatEventTime(
                        new Date(mine.reservedUntil ?? Date.now()),
                        view.shop.desk.timeZone,
                        language,
                      ),
                    })}
              </AppText>
              <PickUp mine={mine} view={view} busy={busy} onCollect={onCollect} />
              {mine.source === "shop" ? (
                <Button
                  kind="quiet"
                  label={t("shop.cancel")}
                  disabled={busy}
                  onPress={() => onCancel(mine.id)}
                />
              ) : (
                <AppText muted>{t("win.noCancel")}</AppText>
              )}
            </>
          ) : (
            <AppText muted>{t(endedKey(mine))}</AppText>
          )}
          {helpOn ? (
            <Button
              kind="quiet"
              label={t("help.prizeProblem")}
              onPress={() =>
                router.push({
                  pathname: "/event/[eventId]/help",
                  params: { eventId, kind: "prize" },
                })
              }
            />
          ) : null}
        </View>
      ))}
    </>
  );
}

/** A digital reward's code: large, left to right in either language, and selectable so a long press copies it. */
function CodeText({ code }: Readonly<{ code: string }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <AppText variant="title" selectable style={styles.code}>
      {code}
    </AppText>
  );
}

/** The rules a player reads before their first redemption in this event (FR-515): the organizer's, else Questify's. */
function RulesText({ view }: Readonly<{ view: ShopView }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const own = view.shop.rules === null ? "" : textIn(view.shop.rules, language);
  return (
    <AppText>
      {own !== ""
        ? own
        : t("shop.standardRules", {
            minutes: formatNumber(view.shop.pickupMinutes, language),
            currency: termFor(terms.currency, language),
          })}
    </AppText>
  );
}

type Step =
  | Readonly<{ reward: ShopReward; stage: "rules" | "confirm" }>
  | Readonly<{ reward: ShopReward; stage: "code"; code: string; testCode: boolean }>
  | undefined;

/**
 * The notice after a reservation, as a message and its values. A digital reward whose code the server could not open:
 * the points are spent, so say who helps.
 */
function reservedNotice(
  reward: ShopReward,
  view: ShopView,
  result: ShopCallAnswer,
  language: Language,
): [MessageKey, Readonly<Record<string, string>>?] {
  if (reward.kind === "digital") {
    return [
      result.kind === "done" && result.code === null ? "shop.codeUnavailable" : "shop.codeKeep",
    ];
  }
  return [
    reward.kind === "experience" ? "shop.reservedExperience" : "shop.reservedItem",
    { minutes: formatNumber(view.shop.pickupMinutes, language) },
  ];
}

/** Reads the shop on focus, and again when a community goal unlocks something (T-306c); signed out goes home. */
function useShop(eventId: string) {
  const { paidCount } = useEvent();
  const [answer, setAnswer] = useState<ShopAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    const next = await fetchShop(api.session, eventId);
    if (next.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setAnswer(next);
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    if (paidCount > 0) {
      void load();
    }
  }, [paidCount, load]);
  return { answer, load };
}

/**
 * The shop's actions and their state: reserve (one key per tap, kept for a retry), cancel, Collect and the goal's pin.
 * Each answer settles the same way: home when signed out, the API's words or "offline" on a refusal, else a reload.
 */
function useShopActions(eventId: string, load: () => Promise<void>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [step, setStep] = useState<Step>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The key of the reservation in flight: a dropped connection retries with it, a new tap makes a new one.
  const pendingKey = useRef<{ rewardId: string; key: string } | undefined>(undefined);

  /** Settles an answer; `done` is the notice to show on success, or null for none. */
  const settle = async (result: ShopCallAnswer, done: string | null): Promise<boolean> => {
    if (result.kind === "signed_out") {
      router.replace("/home");
      return false;
    }
    if (result.kind !== "done") {
      setProblem(result.kind === "network" ? OFFLINE : result.problem);
      return false;
    }
    if (done !== null) {
      setNotice(done);
    }
    await load();
    return true;
  };

  const reserve = async (reward: ShopReward, view: ShopView) => {
    setBusy(true);
    setProblem(null);
    if (pendingKey.current?.rewardId !== reward.id) {
      pendingKey.current = { rewardId: reward.id, key: randomUuid() };
    }
    const result = await reserveReward(api.session, reward.id, pendingKey.current.key);
    if (result.kind !== "network") {
      pendingKey.current = undefined;
    }
    if (await settle(result, t(...reservedNotice(reward, view, result, language)))) {
      // A digital reward's code shows at once; anything else closes the sheet on its notice.
      setStep(
        result.kind === "done" && result.code !== null
          ? { reward, stage: "code", code: result.code, testCode: result.testCode }
          : undefined,
      );
    }
    setBusy(false);
  };

  /** `closed`: the shop has closed, so the points that come back can no longer be redeemed (ADR-337). */
  const cancel = (id: string, closed: boolean) => {
    const confirmed = async () => {
      setBusy(true);
      setProblem(null);
      await settle(await cancelRedemption(api.session, id), t("shop.status.cancelled"));
      setBusy(false);
    };
    const currency = termFor(terms.currency, language);
    const body = t("shop.cancelBody", { currency });
    Alert.alert(
      t("shop.cancelTitle"),
      closed ? `${body} ${t("shop.cancelClosedNote", { currency })}` : body,
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("shop.cancel"), style: "destructive", onPress: () => void confirmed() },
      ],
    );
  };

  // Collect (collect first): ready at the desk for 5 minutes, then My QR for the desk to scan.
  const collect = async (id: string) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await startCollect(api.session, id);
    setBusy(false);
    if (result.kind === "signed_out") {
      router.replace("/home");
    } else if (result.kind === "done") {
      router.push("/my-qr");
      void load();
    } else {
      setProblem(result.kind === "network" ? OFFLINE : result.problem);
    }
  };

  const pin = async (rewardId: string | null) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    await settle(await setGoal(api.session, eventId, rewardId), null);
    setBusy(false);
  };

  const redeem = (reward: ShopReward, view: ShopView) => {
    setProblem(null);
    setNotice(null);
    setStep({ reward, stage: view.shop.firstRedemption ? "rules" : "confirm" });
  };

  return { step, setStep, busy, problem, notice, reserve, cancel, collect, pin, redeem };
}

/** The shop could not be shown: still loading, no longer the player's event, or a failed load with Retry. */
function ShopUnavailable({
  answer,
  onRetry,
}: Readonly<{ answer: Exclude<ShopAnswer, { kind: "shop" }> | undefined; onRetry: () => void }>) {
  const { t } = useI18n();
  return (
    <Screen title={t("nav.rewards")} header={<EventPill />}>
      {answer === undefined ? (
        <AppText muted>{t("common.loading")}</AppText>
      ) : (
        <>
          <AppText accessibilityRole="alert">
            {t(answer.kind === "gone" ? "shop.gone" : "shop.failed")}
          </AppText>
          <Button label={t("common.retry")} onPress={onRetry} />
        </>
      )}
    </Screen>
  );
}

/** The section chips (FR-516): All, then each section with rewards; a newer server's section shows as is. */
function SectionChips({
  sections,
  section,
  onChoose,
}: Readonly<{
  sections: readonly string[];
  section: string | null;
  onChoose: (section: string | null) => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (sections.length === 0) {
    return null;
  }
  return (
    <ScrollView
      horizontal
      contentContainerStyle={styles.row}
      showsHorizontalScrollIndicator={false}
    >
      {[null, ...sections].map((choice) => (
        <Pressable
          key={choice ?? "all"}
          accessibilityRole="button"
          accessibilityState={{ selected: choice === section }}
          onPress={() => onChoose(choice)}
          style={[styles.chip, choice === section && styles.chosen]}
        >
          <AppText variant="label">
            {choice === null
              ? t("shop.all")
              : KNOWN_SECTIONS.has(choice)
                ? t(`rewards.section.${choice as "featured"}`)
                : choice}
          </AppText>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Redeem or Reserve; with reservation Off an item or experience is bought at the desk instead (FR-1834). */
function ReserveButton({
  reward,
  view,
  busy,
  onReserve,
}: Readonly<{ reward: ShopReward; view: ShopView; busy: boolean; onReserve: () => void }>) {
  const { t } = useI18n();
  if (reward.kind === "digital") {
    return <Button label={t("shop.redeem")} disabled={busy} onPress={onReserve} />;
  }
  return view.shop.reservation ? (
    <Button label={t("shop.reserve")} disabled={busy} onPress={onReserve} />
  ) : (
    <AppText variant="label">{t("shop.atDesk")}</AppText>
  );
}

/** Redeem's sheet: the shop's rules before a first redemption, the confirmation, then a digital reward's code. */
function RedeemSheet({
  step,
  view,
  busy,
  problem,
  onStep,
  onReserve,
}: Readonly<{
  step: Step;
  view: ShopView;
  busy: boolean;
  problem: LocalizedText | null;
  onStep: (step: Step) => void;
  onReserve: (reward: ShopReward) => void;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  return (
    <Sheet
      visible={step !== undefined}
      title={t(
        step?.stage === "rules"
          ? "shop.rulesTitle"
          : step?.stage === "code"
            ? "shop.codeTitle"
            : step?.reward.kind === "digital"
              ? "shop.confirmDigitalTitle"
              : "shop.confirmTitle",
      )}
      onClose={() => onStep(undefined)}
    >
      {step?.stage === "rules" ? (
        <>
          <RulesText view={view} />
          <Button
            label={t("common.continue")}
            onPress={() => onStep({ ...step, stage: "confirm" })}
          />
        </>
      ) : null}
      {step?.stage === "confirm" ? (
        <>
          <AppText variant="label">{textIn(step.reward.name, language)}</AppText>
          <Amount
            amount={formatNumber(step.reward.price, language)}
            form="labelled"
            variant="label"
          />
          <AppText>
            {step.reward.kind === "digital"
              ? t("shop.digitalNote")
              : t(step.reward.kind === "experience" ? "shop.pickupExperience" : "shop.pickupItem", {
                  minutes: formatNumber(view.shop.pickupMinutes, language),
                  currency: termFor(terms.currency, language),
                })}
          </AppText>
          {step.reward.kind === "digital" ? null : <DeskLine desk={view.shop.desk} />}
          {view.shop.spendLowersRank ? <AppText>{t("shop.lowersRank")}</AppText> : null}
          <Problem problem={problem} />
          <ReserveButton
            reward={step.reward}
            view={view}
            busy={busy}
            onReserve={() => onReserve(step.reward)}
          />
        </>
      ) : null}
      {step?.stage === "code" ? (
        <>
          <AppText variant="label">{textIn(step.reward.name, language)}</AppText>
          <CodeText code={step.code} />
          <AppText muted>{t(step.testCode ? "rehearsal.testCode" : "shop.codeKeep")}</AppText>
          <Button label={t("common.close")} onPress={() => onStep(undefined)} />
        </>
      ) : null}
    </Sheet>
  );
}

/** The sections and the rewards with their buttons; not offered once the shop has closed. */
function Catalog({
  view,
  section,
  busy,
  onSection,
  actions,
}: Readonly<{
  view: ShopView;
  section: string | null;
  busy: boolean;
  onSection: (section: string | null) => void;
  actions: ReturnType<typeof useShopActions>;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const sponsors = useSponsors();
  const grid = useEvent().layout.looks.shop === "grid";
  return (
    <>
      <SectionChips sections={sectionsOf(view.rewards)} section={section} onChoose={onSection} />
      {view.rewards.length === 0 ? <AppText muted>{t("shop.empty")}</AppText> : null}
      <View style={grid ? styles.grid : styles.stack}>
        {inSection(view.rewards, section).map((reward) => (
          <RewardCard
            key={reward.id}
            reward={reward}
            sponsor={sponsors.of("reward", reward.id)}
            view={view}
            busy={busy}
            compact={grid}
            onPin={() => void actions.pin(view.goalRewardId === reward.id ? null : reward.id)}
            onRedeem={() => actions.redeem(reward, view)}
          />
        ))}
      </View>
    </>
  );
}

/**
 * The event's rewards shop (T-201, T-202): the balance, sections, each reward with its real stock (FR-514), Redeem with
 * a confirmation (the shop's rules first, once, FR-515), the goal's pin (FR-517), and the player's reservations with
 * time left and Cancel.
 */
export default function RewardsScreen() {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const styles = useThemedStyles(makeStyles);
  const [section, setSection] = useState<string | null>(null);
  const { answer, load } = useShop(eventId);
  const actions = useShopActions(eventId, load);

  if (answer === undefined || answer.kind !== "shop") {
    return <ShopUnavailable answer={answer} onRetry={() => void load()} />;
  }
  const { view } = answer;
  const closed = view.shop.state === "closed";
  return (
    <Screen title={t("nav.rewards")} header={<EventPill />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <View style={styles.row}>
          <AppText variant="label">{t("shop.balance")}</AppText>
          {closed ? (
            <AppText variant="label">{t("eventHome.balanceClosed")}</AppText>
          ) : (
            <Amount amount={formatNumber(view.balance, language)} form="labelled" variant="label" />
          )}
        </View>
        {view.shop.state === "not_open" ? (
          <AppText accessibilityRole="alert">{t("shop.notOpen")}</AppText>
        ) : null}
        {closed ? (
          <ShopClosedPanel closesAt={view.shop.closesAt} timeZone={view.shop.desk.timeZone} />
        ) : null}
        {actions.notice === null ? null : (
          <AppText accessibilityRole="alert">{actions.notice}</AppText>
        )}
        <Problem problem={actions.problem} />
        {closed ? null : (
          <Catalog
            view={view}
            section={section}
            busy={actions.busy}
            onSection={setSection}
            actions={actions}
          />
        )}
        <MyReservations
          view={view}
          busy={actions.busy}
          onCancel={(id) => actions.cancel(id, closed)}
          onCollect={(id) => void actions.collect(id)}
        />
      </ScrollView>
      <RedeemSheet
        step={actions.step}
        view={view}
        busy={actions.busy}
        problem={actions.problem}
        onStep={actions.setStep}
        onReserve={(reward) => void actions.reserve(reward, view)}
      />
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    gap: theme.spacing.sm,
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  tileBody: { gap: theme.spacing.sm },
  stack: { gap: theme.spacing.lg },
  // The shop's grid (FR-1833): two cards a row; the cards of a row stretch to the tallest, and none is shorter than the minimum.
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  tile: {
    width: "48%" as const,
    minHeight: 220,
    justifyContent: "space-between" as const,
    borderBottomWidth: 4,
  },
  tag: {
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.primaryAction,
  },
  chip: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  chosen: { borderColor: theme.colors.primaryAction },
  // Codes are Latin letters and digits: they read left to right inside Arabic too.
  code: {
    writingDirection: "ltr" as const,
    textAlign: "center" as const,
    fontVariant: ["tabular-nums" as const],
  },
});
