import { DEFAULT_TERMS, formatNumber, termFor, type LocalizedText } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  EMPTY_DRAFT,
  afterAward,
  amountOf,
  awardBody,
  canAward,
  capProblem,
  refusalSaid,
  type AwardDraft,
  type AwardForm,
  type FoundPlayer,
  type Said,
} from "#src/operator/award.ts";
import {
  fetchAwardForm,
  findPlayerToAward,
  sendAward,
  type AwardRefused,
  type Refused,
} from "#src/operator/operator-api.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";

/** A problem to show: one of the app's own lines, or the API's message as it came. */
type Shown = Said | Readonly<{ text: LocalizedText }> | "network";

const shownOf = (refused: Refused | AwardRefused): Shown => {
  const said = refusalSaid(refused.code, "details" in refused ? refused.details : {});
  if (said !== undefined) {
    return said;
  }
  return refused.message === null ? "network" : { text: refused.message };
};

function ProblemLine({ shown }: Readonly<{ shown: Shown | null }>) {
  const { t, language } = useI18n();
  if (shown === null) {
    return null;
  }
  const words =
    shown === "network"
      ? t("join.network")
      : "text" in shown
        ? shown.text[language]
        : t(shown.key, shown.params);
  return <AppText accessibilityRole="alert">{words}</AppText>;
}

/** The quest or amount, the reason, and the caps in force, always visible (FR-310). */
function AwardFields({
  form,
  draft,
  change,
}: Readonly<{ form: AwardForm; draft: AwardDraft; change: (next: AwardDraft) => void }>) {
  const { t, language } = useI18n();
  const amount = amountOf(draft, form);
  const over = amount === undefined ? undefined : capProblem(amount, form);
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="label">{t("awards.what")}</AppText>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["points", "quest"] as const).map((mode) => (
          <Button
            key={mode}
            kind={draft.mode === mode ? "primary" : "quiet"}
            label={t(mode === "points" ? "awards.somePoints" : "awards.aQuest")}
            disabled={mode === "quest" && form.quests.length === 0}
            onPress={() => change({ ...draft, mode })}
          />
        ))}
      </View>
      {draft.mode === "points" ? (
        <Field
          label={t("awards.amount")}
          keyboardType="number-pad"
          value={draft.points}
          onChangeText={(points) => change({ ...draft, points })}
          style={{ textAlign: "left", writingDirection: "ltr" }}
        />
      ) : (
        form.quests.map((quest) => (
          <Button
            key={quest.id}
            kind={draft.questId === quest.id ? "primary" : "quiet"}
            label={`${textIn(quest.title, language)} · ${formatNumber(quest.points, language)}`}
            onPress={() => change({ ...draft, questId: quest.id })}
          />
        ))
      )}
      <Field
        label={t("awards.reason")}
        value={draft.reason}
        maxLength={300}
        multiline
        onChangeText={(reason) => change({ ...draft, reason })}
      />
      <AppText muted>
        {t("operator.award.limitEach", { limit: formatNumber(form.capEach, language) })}
      </AppText>
      <AppText muted>
        {t("operator.award.leftToday", {
          left: formatNumber(form.leftToday, language),
          day: formatNumber(form.capDay, language),
        })}
      </AppText>
      {over === undefined ? null : <ProblemLine shown={over} />}
    </View>
  );
}

/** Find a member by exact username or mobile number (FR-308); a miss awards nothing. */
function FindCard({
  eventId,
  found,
  onFound,
  onRemoved,
}: Readonly<{
  eventId: string;
  found: FoundPlayer | null;
  onFound: (player: FoundPlayer | null) => void;
  onRemoved: () => void;
}>) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [missed, setMissed] = useState(false);
  const player = termFor(DEFAULT_TERMS.player, language);
  const search = async () => {
    setBusy(true);
    setProblem(null);
    setMissed(false);
    const answer = await findPlayerToAward(api.session, eventId, query.trim());
    setBusy(false);
    if (answer.kind === "removed") {
      onRemoved();
    } else if (answer.kind === "found") {
      setMissed(answer.player === null);
      onFound(answer.player);
    } else {
      setProblem(answer.kind === "refused" ? shownOf(answer) : "network");
    }
  };
  return (
    <View style={{ gap: 12 }}>
      <Field
        label={t("operator.award.find", { player })}
        placeholder={t("operator.award.findHint")}
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void search()}
      />
      <Button
        kind="quiet"
        label={t("operator.award.search")}
        disabled={busy || query.trim() === ""}
        onPress={() => void search()}
      />
      {missed ? (
        <AppText accessibilityRole="alert">{t("operator.award.noMatch", { player })}</AppText>
      ) : null}
      <ProblemLine shown={problem} />
      {found === null ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Avatar name={found.avatar} username={found.username} size={48} />
          <AppText variant="title">{found.username}</AppText>
        </View>
      )}
      {found !== null && !found.active ? (
        <AppText accessibilityRole="alert">{t("operator.award.inactive", { player })}</AppText>
      ) : null}
    </View>
  );
}

/** Before sending, the award is repeated: who, what, how many, the reason (F-196). */
function ConfirmCard({
  form,
  player,
  draft,
  busy,
  onConfirm,
  onBack,
}: Readonly<{
  form: AwardForm;
  player: FoundPlayer;
  draft: AwardDraft;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
}>) {
  const { t, language } = useI18n();
  const quest = form.quests.find((item) => item.id === draft.questId);
  const points = formatNumber(amountOf(draft, form) ?? 0, language);
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="title">{t("awards.confirmTitle")}</AppText>
      <AppText>
        {t("awards.confirmBody", {
          name: player.username,
          points:
            draft.mode === "quest" && quest !== undefined
              ? `${textIn(quest.title, language)}: ${points}`
              : points,
          reason: draft.reason.trim(),
        })}
      </AppText>
      <Button label={t("awards.confirm")} disabled={busy} onPress={onConfirm} />
      <Button kind="quiet" label={t("awards.back")} disabled={busy} onPress={onBack} />
    </View>
  );
}

/** The form before it loads, or why it did not. */
function FormLoading({
  failed,
  problem,
  retry,
}: Readonly<{ failed: boolean; problem: Shown | null; retry: () => void }>) {
  const { t } = useI18n();
  return (
    <Screen title={t("operator.award.title")} header={<BackButton />}>
      {failed ? null : <AppText muted>{t("common.loading")}</AppText>}
      {failed && problem === null ? (
        <AppText accessibilityRole="alert">{t("awards.loadFailed")}</AppText>
      ) : null}
      <ProblemLine shown={problem} />
      {failed ? <Button label={t("common.retry")} onPress={retry} /> : null}
    </Screen>
  );
}

/** "Awarded 50 to Sara_88. Reason saved." and the way to the next award. */
function DoneCard({
  points,
  name,
  another,
}: Readonly<{ points: number; name: string; another: () => void }>) {
  const { t, language } = useI18n();
  return (
    <>
      <AppText accessibilityRole="alert" variant="title">
        {t("operator.award.done", { points: formatNumber(points, language), name })}
      </AppText>
      <Button label={t("operator.award.another")} onPress={another} />
    </>
  );
}

type Step = "fill" | "confirm" | Readonly<{ done: number; name: string }>;

/**
 * Manual award in operator mode (FR-308 to FR-310, OPERATOR_MODE 3.5): find a member, pick a quest or an amount,
 * write the reason, confirm. The caps show on the form; the server checks them again on the award.
 */
export default function ManualAwardScreen() {
  const { t } = useI18n();
  const { eventId, removed } = useOperator();
  const [form, setForm] = useState<AwardForm | null | "failed">(null);
  const [player, setPlayer] = useState<FoundPlayer | null>(null);
  const [draft, setDraft] = useState<AwardDraft>(EMPTY_DRAFT);
  const [step, setStep] = useState<Step>("fill");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const key = useRef("");

  const load = useCallback(async () => {
    const answer = await fetchAwardForm(api.session, eventId);
    if (answer.kind === "removed") {
      removed();
      return;
    }
    setForm(answer.kind === "form" ? answer.form : "failed");
    setProblem(answer.kind === "refused" ? shownOf(answer) : null);
  }, [eventId, removed]);
  useEffect(() => {
    void load();
  }, [load]);

  if (form === null || form === "failed") {
    return <FormLoading failed={form === "failed"} problem={problem} retry={() => void load()} />;
  }

  const send = async (target: FoundPlayer) => {
    setBusy(true);
    setProblem(null);
    const answer = await sendAward(api.session, awardBody(eventId, target, draft), key.current);
    setBusy(false);
    if (answer.kind === "removed") {
      removed();
    } else if (answer.kind === "awarded") {
      setForm(afterAward(form, answer.points));
      setStep({ done: answer.points, name: target.username });
    } else {
      setStep("fill");
      setProblem(answer.kind === "refused" ? shownOf(answer) : "network");
    }
  };
  const another = () => {
    setPlayer(null);
    setDraft(EMPTY_DRAFT);
    setStep("fill");
    void load();
  };

  return (
    <Screen title={t("operator.award.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
        {form.live ? null : (
          <AppText accessibilityRole="alert">{t("operator.award.notLive")}</AppText>
        )}
        {typeof step === "object" ? (
          <DoneCard points={step.done} name={step.name} another={another} />
        ) : null}
        {step === "confirm" && player !== null ? (
          <ConfirmCard
            form={form}
            player={player}
            draft={draft}
            busy={busy}
            onConfirm={() => void send(player)}
            onBack={() => setStep("fill")}
          />
        ) : null}
        {step === "fill" ? (
          <>
            <FindCard eventId={eventId} found={player} onFound={setPlayer} onRemoved={removed} />
            <AwardFields form={form} draft={draft} change={setDraft} />
            <ProblemLine shown={problem} />
            <Button
              label={t("awards.award")}
              disabled={!canAward(player, draft, form)}
              onPress={() => {
                key.current = randomUuid();
                setProblem(null);
                setStep("confirm");
              }}
            />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
