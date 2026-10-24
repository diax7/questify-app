import type { LocalizedText, MessageKey } from "@questify/shared";
import { formatNumber } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { questCodeOrigin } from "#src/event/scan.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn, type Bilingual } from "#src/i18n/text.ts";
import { writeTag } from "#src/nfc/native.ts";
import {
  confirmWrite,
  fetchWritePage,
  prepareWrite,
  type Confirmed,
  type WritePage,
} from "#src/nfc/nfc-api.ts";
import { useNfcSupported } from "#src/nfc/NfcTap.tsx";
import { useOperator } from "#src/operator/OperatorContext.tsx";

const EXTRA_ORIGIN = questCodeOrigin(process.env["EXPO_PUBLIC_QUEST_CODE_ORIGIN"], __DEV__);

/**
 * A tag written on the phone whose confirm did not reach the server: retried with the same key and the same body (the
 * quest, label and lock as written, whatever the form says now), never rewritten.
 */
type Pending = Readonly<{
  questId: string;
  quest: Bilingual;
  url: string;
  ticket: string;
  uid: string;
  label: string;
  locked: boolean;
  /** The operator asked for a lock the tag did not take. */
  lockMissed: boolean;
  key: string;
}>;

type Step =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "writing" }>
  | Readonly<{ kind: "done"; quest: Bilingual; confirmed: Confirmed; lockMissed: boolean }>
  | Readonly<{ kind: "problem"; key: MessageKey; rewrite: boolean }>
  | Readonly<{ kind: "refused"; message: LocalizedText }>
  | Readonly<{ kind: "unconfirmed"; pending: Pending }>;

const PROBLEMS = {
  locked: "operator.nfc.locked",
  taken: "operator.nfc.taken",
  failed: "operator.nfc.failed",
  unsupported: "operator.nfc.unsupported",
  off: "operator.nfc.off",
  unusable: "operator.nfc.unusable",
} as const satisfies Record<string, MessageKey>;

/**
 * Staff mode's Write NFC tag (FR-312, FR-922): pick a scan quest with NFC on, name the tag, lock it (on by default,
 * permanent), hold a tag to the phone. The phone writes the signed URL the server prepared, reads it back, locks it,
 * and the server registers the sticker. Nothing is stored before the server's answer.
 */
export default function NfcWriteScreen() {
  const { t, language } = useI18n();
  const { eventId } = useOperator();
  const supported = useNfcSupported();
  const [page, setPage] = useState<WritePage | null | undefined>(undefined);
  const [questId, setQuestId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [lock, setLock] = useState(true);
  const [step, setStep] = useState<Step>({ kind: "idle" });

  const load = useCallback(async () => {
    const answer = await fetchWritePage(api.session, eventId);
    setPage(answer.kind === "page" ? answer.page : null);
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  const quest = page?.quests.find((item) => item.id === questId);

  const confirm = async (pending: Pending) => {
    const answer = await confirmWrite(
      api.session,
      {
        eventId,
        questId: pending.questId,
        url: pending.url,
        ticket: pending.ticket,
        uid: pending.uid,
        label: pending.label,
        locked: pending.locked,
      },
      pending.key,
    );
    if (answer.kind === "confirmed") {
      setStep({
        kind: "done",
        quest: pending.quest,
        confirmed: answer,
        lockMissed: pending.lockMissed,
      });
      void load();
    } else if (answer.kind === "refused" && answer.message !== null) {
      setStep({ kind: "refused", message: answer.message });
    } else {
      setStep({ kind: "unconfirmed", pending });
    }
  };

  const write = async (rewrite: boolean) => {
    if (quest === undefined) {
      return;
    }
    setStep({ kind: "writing" });
    const prepared = await prepareWrite(api.session, eventId, quest.id);
    if (prepared.kind !== "prepared") {
      setStep(
        prepared.kind === "refused" && prepared.message !== null
          ? { kind: "refused", message: prepared.message }
          : { kind: "problem", key: "join.network", rewrite: false },
      );
      return;
    }
    const written = await writeTag({
      url: prepared.url,
      lock,
      rewrite,
      alert: t("operator.nfc.hold"),
      extraOrigin: EXTRA_ORIGIN,
    });
    if (written.kind === "cancelled") {
      setStep({ kind: "idle" });
      return;
    }
    if (written.kind !== "written") {
      setStep({ kind: "problem", key: PROBLEMS[written.kind], rewrite: written.kind === "taken" });
      return;
    }
    await confirm({
      questId: quest.id,
      quest: quest.title,
      label,
      locked: written.locked,
      lockMissed: lock && !written.locked,
      url: prepared.url,
      ticket: prepared.ticket,
      uid: written.uid,
      key: randomUuid(),
    });
  };

  if (supported === false) {
    return (
      <Screen title={t("operator.nfc.write")} header={<BackButton />}>
        <AppText>{t("operator.nfc.unsupported")}</AppText>
      </Screen>
    );
  }
  return (
    <Screen title={t("operator.nfc.write")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {page === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {page === null ? <AppText accessibilityRole="alert">{t("join.network")}</AppText> : null}
        {page?.quests.length === 0 ? <AppText>{t("operator.nfc.noQuests")}</AppText> : null}
        {page !== null && page !== undefined && page.quests.length > 0 ? (
          <>
            <AppText variant="label">{t("operator.nfc.pickQuest")}</AppText>
            {page.quests.map((item) => (
              <Button
                key={item.id}
                kind={item.id === questId ? "primary" : "quiet"}
                label={`${textIn(item.title, language)} · ${t("operator.nfc.tagCount", {
                  count: formatNumber(item.tags, language),
                })}`}
                onPress={() => {
                  setQuestId(item.id);
                  setStep({ kind: "idle" });
                }}
              />
            ))}
            <Field
              label={t("operator.nfc.label")}
              value={label}
              onChangeText={setLabel}
              maxLength={40}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Switch
                value={lock}
                onValueChange={setLock}
                accessibilityLabel={t("operator.nfc.lock")}
              />
              <AppText>{t("operator.nfc.lock")}</AppText>
            </View>
            <AppText muted>{t("operator.nfc.lockHint")}</AppText>
            <Button
              label={t("operator.nfc.start")}
              disabled={quest === undefined || step.kind === "writing"}
              onPress={() => void write(false)}
            />
          </>
        ) : null}
        <Outcome
          step={step}
          onRewrite={() => void write(true)}
          onRetry={(pending) => void confirm(pending)}
        />
        {page !== null && page !== undefined && page.tags.length > 0 ? (
          <>
            <AppText variant="label">{t("operator.nfc.recent")}</AppText>
            {page.tags.map((tag) => (
              <AppText key={tag.id} muted>
                {`${tag.label === "" ? t("tags.unnamed") : tag.label} · ${textIn(tag.quest, language)}`}
              </AppText>
            ))}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** What the last write gave: holding, done (and what it replaced), or why not, with Rewrite or Retry where they help. */
function Outcome({
  step,
  onRewrite,
  onRetry,
}: Readonly<{ step: Step; onRewrite: () => void; onRetry: (pending: Pending) => void }>) {
  const { t, language } = useI18n();
  switch (step.kind) {
    case "idle":
      return null;
    case "writing":
      return <AppText accessibilityRole="alert">{t("operator.nfc.hold")}</AppText>;
    case "done": {
      const replaced = step.confirmed.replaced;
      return (
        <>
          <AppText variant="title" accessibilityRole="alert">
            {t("operator.nfc.done", { quest: textIn(step.quest, language) })}
          </AppText>
          {step.lockMissed ? <AppText>{t("operator.nfc.notLocked")}</AppText> : null}
          {replaced === null ? null : (
            <AppText>
              {t("operator.nfc.replaced", {
                label: replaced.label === "" ? t("tags.unnamed") : replaced.label,
                quest: textIn(replaced.quest, language),
              })}
            </AppText>
          )}
        </>
      );
    }
    case "problem":
      return (
        <>
          <AppText accessibilityRole="alert">{t(step.key)}</AppText>
          {step.rewrite ? (
            <Button kind="quiet" label={t("operator.nfc.rewrite")} onPress={onRewrite} />
          ) : null}
        </>
      );
    case "refused":
      return <AppText accessibilityRole="alert">{step.message[language]}</AppText>;
    case "unconfirmed":
      return (
        <>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button label={t("common.retry")} onPress={() => onRetry(step.pending)} />
        </>
      );
  }
}
