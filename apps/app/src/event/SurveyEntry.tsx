import { SURVEY_TEXT_MAX, formatNumber, type LocalizedText, type Theme } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field, Problem } from "#src/components/Controls.tsx";
import { paidText } from "#src/event/amount.ts";
import { ChoiceList } from "#src/event/ChoiceList.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import type { Quest } from "#src/event/quests-api.ts";
import {
  RATINGS,
  answersOf,
  fetchSurvey,
  missingAnswers,
  sendSurvey,
  type SurveyDraft,
  type SurveyQuestion,
  type SurveyView,
} from "#src/event/survey-share.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** One to five, as buttons read as a radio group; each says its number to a screen reader. */
function RatingRow({
  value,
  disabled,
  onChoose,
}: Readonly<{ value: number | undefined; disabled: boolean; onChoose: (rating: number) => void }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityRole="radiogroup" style={styles.ratings}>
      {RATINGS.map((rating) => (
        <Pressable
          key={rating}
          accessibilityRole="radio"
          accessibilityLabel={t("play.survey.ratingLabel", { rating, max: 5 })}
          accessibilityState={{ checked: value === rating, disabled }}
          disabled={disabled}
          onPress={() => onChoose(rating)}
          style={[styles.rating, value !== undefined && rating <= value && styles.lit]}
        >
          <AppText variant="label">{formatNumber(rating, language)}</AppText>
        </Pressable>
      ))}
    </View>
  );
}

function QuestionField({
  question,
  value,
  disabled,
  marked,
  onChange,
}: Readonly<{
  question: SurveyQuestion;
  value: string | number | undefined;
  disabled: boolean;
  marked: boolean;
  onChange: (value: string | number) => void;
}>) {
  const { t, language } = useI18n();
  const label = `${textIn(question.text, language)}${question.required ? " *" : ""}`;
  const typed = typeof value === "string" ? value : "";
  return (
    <View>
      {question.kind === "text" ? null : <AppText variant="label">{label}</AppText>}
      {question.kind === "choice" ? (
        <ChoiceList
          choices={question.choices ?? []}
          chosen={typeof value === "string" ? value : null}
          disabled={disabled}
          onChoose={onChange}
        />
      ) : null}
      {question.kind === "rating" ? (
        <RatingRow
          value={typeof value === "number" ? value : undefined}
          disabled={disabled}
          onChoose={onChange}
        />
      ) : null}
      {question.kind === "text" ? (
        <>
          <Field
            label={label}
            value={typed}
            editable={!disabled}
            multiline
            maxLength={SURVEY_TEXT_MAX}
            onChangeText={onChange}
          />
          <AppText muted>
            {t("submission.counter", {
              count: formatNumber(typed.trim().length, language),
              max: formatNumber(SURVEY_TEXT_MAX, language),
            })}
          </AppText>
        </>
      ) : null}
      {marked ? <AppText accessibilityRole="alert">{t("play.survey.checkThis")}</AppText> : null}
    </View>
  );
}

/**
 * A survey quest in the quest sheet (FR-214): one form, required questions marked, one response. A retry after a dropped
 * connection keeps the same key while the answers are unchanged, so the response is never counted twice.
 */
export function SurveyEntry({ quest, onPaid }: Readonly<{ quest: Quest; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [view, setView] = useState<SurveyView | undefined | "failed">(undefined);
  const [draft, setDraft] = useState<SurveyDraft>({});
  const [marked, setMarked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [last, setLast] = useState<{ key: string; sent: string } | undefined>(undefined);

  const load = useCallback(async () => {
    setView((await fetchSurvey(api.session, quest.id)) ?? "failed");
  }, [quest.id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) {
    return null;
  }
  if (view === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("play.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
      </>
    );
  }
  if (view.answered) {
    return <AppText variant="label">{said ?? t("play.survey.answered")}</AppText>;
  }
  if (quest.state !== "open") {
    return null;
  }
  const send = async () => {
    const missing = missingAnswers(view.questions, draft);
    setMarked(missing);
    if (missing.length > 0) {
      setProblem(null);
      setSaid(t("play.survey.missing"));
      return;
    }
    const answers = answersOf(view.questions, draft);
    const sent = JSON.stringify(answers);
    const key = last?.sent === sent ? last.key : randomUuid();
    setLast({ key, sent });
    setBusy(true);
    setProblem(null);
    setSaid(null);
    const answer = await sendSurvey(api.session, quest.id, answers, key);
    setBusy(false);
    if (answer.kind === "voted") {
      setSaid(`${t("play.survey.thanks")} ${paidText(t, terms, language, answer)}`);
      onPaid();
      await load();
      return;
    }
    if (answer.kind === "refused") {
      setMarked(answer.question === undefined ? [] : [answer.question]);
      setProblem(answer.message);
    } else if (answer.kind === "network") {
      setSaid(t("join.network"));
    }
  };
  return (
    <>
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      <AppText muted>{t("play.survey.private")}</AppText>
      {view.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          value={draft[question.id]}
          disabled={busy}
          marked={marked.includes(question.id)}
          onChange={(value) => setDraft({ ...draft, [question.id]: value })}
        />
      ))}
      <Problem problem={problem} />
      <Button label={t("play.survey.send")} disabled={busy} onPress={() => void send()} />
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  ratings: { flexDirection: "row" as const, gap: theme.spacing.sm },
  rating: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  lit: { borderColor: theme.colors.primaryAction, backgroundColor: theme.colors.surface },
});
