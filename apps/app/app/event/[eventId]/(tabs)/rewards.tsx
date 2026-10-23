import {
  MESSAGES,
  formatNumber,
  termFor,
  type LocalizedText,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
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
import {
  cancelRedemption,
  fetchShop,
  inSection,
  minutesLeft,
  reserveReward,
  rewardAction,
  sectionsOf,
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

function RewardCard({
  reward,
  view,
  onRedeem,
}: Readonly<{ reward: ShopReward; view: ShopView; onRedeem: () => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const terms = useTerms();
  const action = rewardAction(reward, view, Date.now());
  const description = textIn(reward.description, language);
  return (
    <View style={styles.card}>
      <AppText variant="title">{textIn(reward.name, language)}</AppText>
      <Tags reward={reward} />
      {description === "" ? null : <AppText>{description}</AppText>}
      <View style={styles.row}>
        <Amount amount={formatNumber(reward.price, language)} form="labelled" variant="label" />
        <AppText muted>
          {reward.stockLeft > 0
            ? t("shop.left", { count: formatNumber(reward.stockLeft, language) })
            : t("shop.soldOut")}
        </AppText>
      </View>
      {action === "redeem" ? (
        <Button label={t("shop.redeem")} onPress={onRedeem} />
      ) : (
        <AppText muted accessibilityRole="text">
          {t(ACTION_TEXT[action], { currency: termFor(terms.currency, language) })}
        </AppText>
      )}
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
                {t("shop.minutesLeft", {
                  minutes: formatNumber(minutesLeft(mine.reservedUntil, Date.now()), language),
                })}
              </AppText>
              <PickUp mine={mine} view={view} busy={busy} onCollect={onCollect} />
              <Button
                kind="quiet"
                label={t("shop.cancel")}
                disabled={busy}
                onPress={() => onCancel(mine.id)}
              />
            </>
          ) : (
            <AppText muted>{t(endedKey(mine))}</AppText>
          )}
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
 * The event's rewards shop (T-201, T-202): the balance, sections, each reward with its real stock (FR-514), Redeem with
 * a confirmation (the shop's rules first, once, FR-515), and the player's reservations with time left and Cancel.
 */
export default function RewardsScreen() {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState<ShopAnswer | undefined>(undefined);
  const [section, setSection] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The key of the reservation in flight: a dropped connection retries with it, a new tap makes a new one.
  const pendingKey = useRef<{ rewardId: string; key: string } | undefined>(undefined);

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

  const settle = async (result: ShopCallAnswer, done: string): Promise<boolean> => {
    if (result.kind === "signed_out") {
      router.replace("/home");
      return false;
    }
    if (result.kind !== "done") {
      setProblem(result.kind === "network" ? OFFLINE : result.problem);
      return false;
    }
    setNotice(done);
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
    // A digital reward whose code the server could not open: the points are spent, so say who helps.
    const reserved =
      reward.kind === "digital"
        ? t(
            result.kind === "done" && result.code === null
              ? "shop.codeUnavailable"
              : "shop.codeKeep",
          )
        : t(reward.kind === "experience" ? "shop.reservedExperience" : "shop.reservedItem", {
            minutes: formatNumber(view.shop.pickupMinutes, language),
          });
    if (await settle(result, reserved)) {
      // A digital reward's code shows at once; anything else closes the sheet on its notice.
      setStep(
        result.kind === "done" && result.code !== null
          ? { reward, stage: "code", code: result.code, testCode: result.testCode }
          : undefined,
      );
    }
    setBusy(false);
  };

  const cancel = (id: string) => {
    Alert.alert(
      t("shop.cancelTitle"),
      t("shop.cancelBody", { currency: termFor(terms.currency, language) }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("shop.cancel"),
          style: "destructive",
          onPress: () =>
            void (async () => {
              setBusy(true);
              setProblem(null);
              await settle(await cancelRedemption(api.session, id), t("shop.status.cancelled"));
              setBusy(false);
            })(),
        },
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

  if (answer === undefined || answer.kind !== "shop") {
    return (
      <Screen title={t("nav.rewards")} header={<EventPill />}>
        {answer === undefined ? (
          <AppText muted>{t("common.loading")}</AppText>
        ) : (
          <>
            <AppText accessibilityRole="alert">
              {t(answer.kind === "gone" ? "shop.gone" : "shop.failed")}
            </AppText>
            <Button label={t("common.retry")} onPress={() => void load()} />
          </>
        )}
      </Screen>
    );
  }

  const { view } = answer;
  const sections = sectionsOf(view.rewards);
  const shown = inSection(view.rewards, section);
  return (
    <Screen title={t("nav.rewards")} header={<EventPill />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <View style={styles.row}>
          <AppText variant="label">{t("shop.balance")}</AppText>
          <Amount amount={formatNumber(view.balance, language)} form="labelled" variant="label" />
        </View>
        {view.shop.state === "open" ? null : (
          <AppText accessibilityRole="alert">
            {t(view.shop.state === "not_open" ? "shop.notOpen" : "shop.closed")}
          </AppText>
        )}
        {notice === null ? null : <AppText accessibilityRole="alert">{notice}</AppText>}
        <Problem problem={problem} />
        {sections.length === 0 ? null : (
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
                onPress={() => setSection(choice)}
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
        )}
        {view.rewards.length === 0 ? <AppText muted>{t("shop.empty")}</AppText> : null}
        {shown.map((reward) => (
          <RewardCard
            key={reward.id}
            reward={reward}
            view={view}
            onRedeem={() => {
              setProblem(null);
              setNotice(null);
              setStep({ reward, stage: view.shop.firstRedemption ? "rules" : "confirm" });
            }}
          />
        ))}
        <MyReservations
          view={view}
          busy={busy}
          onCancel={cancel}
          onCollect={(id) => void collect(id)}
        />
      </ScrollView>
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
        onClose={() => setStep(undefined)}
      >
        {step?.stage === "rules" ? (
          <>
            <RulesText view={view} />
            <Button
              label={t("common.continue")}
              onPress={() => setStep({ ...step, stage: "confirm" })}
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
                : t(
                    step.reward.kind === "experience" ? "shop.pickupExperience" : "shop.pickupItem",
                    {
                      minutes: formatNumber(view.shop.pickupMinutes, language),
                      currency: termFor(terms.currency, language),
                    },
                  )}
            </AppText>
            {step.reward.kind === "digital" ? null : <DeskLine desk={view.shop.desk} />}
            {view.shop.spendLowersRank ? <AppText>{t("shop.lowersRank")}</AppText> : null}
            <Problem problem={problem} />
            <Button
              label={t(step.reward.kind === "digital" ? "shop.redeem" : "shop.reserve")}
              disabled={busy}
              onPress={() => void reserve(step.reward, view)}
            />
          </>
        ) : null}
        {step?.stage === "code" ? (
          <>
            <AppText variant="label">{textIn(step.reward.name, language)}</AppText>
            <CodeText code={step.code} />
            <AppText muted>{t(step.testCode ? "rehearsal.testCode" : "shop.codeKeep")}</AppText>
            <Button label={t("common.close")} onPress={() => setStep(undefined)} />
          </>
        ) : null}
      </Sheet>
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
