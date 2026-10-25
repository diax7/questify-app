import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import {
  AVATARS,
  EMPTY_EQUIPMENT,
  MESSAGES,
  type ProfilePatch,
  type Equipment,
  type ProfileItem,
} from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { lockerPage, saveProfile, type LockerEntry } from "#src/questify/profile-api.ts";

function useLocker(owner: string | undefined) {
  const [items, setItems] = useState<LockerEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const [loadedOwner, setLoadedOwner] = useState<string>();
  useFocusEffect(
    useCallback(() => {
      let current = true;
      epoch.current += 1;
      setBusy(false);
      setItems(null);
      setFailed(false);
      setCursor(null);
      if (owner !== undefined)
        void lockerPage(api.session).then((page) => {
          if (!current) return;
          setLoadedOwner(owner);
          setFailed(page === null);
          setItems(page?.items ?? null);
          setCursor(page?.nextCursor ?? null);
        });
      return () => {
        current = false;
        epoch.current += 1;
      };
    }, [owner, attempt]),
  );
  const more = async () => {
    if (cursor === null || busy) return;
    setBusy(true);
    const generation = epoch.current;
    const page = await lockerPage(api.session, cursor);
    if (generation !== epoch.current) return;
    setBusy(false);
    if (page === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setItems((current) => [...(current ?? []), ...page.items]);
    setCursor(page.nextCursor);
  };
  return {
    items: loadedOwner === owner ? items : null,
    cursor: loadedOwner === owner ? cursor : null,
    failed: loadedOwner === owner && failed,
    busy,
    more,
    retry: () => setAttempt((n) => n + 1),
  };
}

function previewEquipment(
  equipment: Equipment,
  draft: ProfilePatch,
  items: LockerEntry[] | null,
): Equipment {
  const preview = { ...equipment };
  for (const slot of ["character", "frame", "title"] as const) {
    const field = `${slot}Id` as const;
    if (field in draft)
      preview[slot] = items?.find((row) => row.item.id === draft[field])?.item ?? null;
  }
  if (draft.avatar !== undefined) preview.character = null;
  return preview;
}
function useAppearance(
  me: import("#src/auth/player.tsx").Me | undefined,
  locker: ReturnType<typeof useLocker>,
) {
  const { reload } = usePlayer();
  const owner = useRef(me?.id);
  owner.current = me?.id;
  const [draft, setDraft] = useState<ProfilePatch>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ ar: string; en: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft({});
    setProblem(null);
    setSaved(false);
    setBusy(false);
  }, [me?.id]);
  const equipment = me?.equipment ?? EMPTY_EQUIPMENT;
  const select = (patch: ProfilePatch) => {
    setDraft(patch);
    setSaved(false);
    setProblem(null);
  };
  const save = async () => {
    if (busy || Object.keys(draft).length === 0) return;
    setBusy(true);
    setProblem(null);
    const current = owner.current;
    const answer = await saveProfile(api.session, draft);
    if (current !== owner.current) return;
    if (answer.kind === "ok") {
      await reload();
      if (current !== owner.current) return;
      setDraft({});
      setSaved(true);
    } else
      setProblem(
        answer.kind === "error" && answer.message !== null
          ? answer.message
          : MESSAGES["profile.saveFailed"],
      );
    setBusy(false);
  };
  const preview = previewEquipment(equipment, draft, locker.items);
  return { draft, busy, problem, saved, select, save, preview };
}

function StarterChoices({
  username,
  select,
}: {
  username: string;
  select: (patch: ProfilePatch) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {AVATARS.map((avatar) => (
        <View key={avatar} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Avatar name={avatar} username={username} size={48} />
          <Button
            label={t(avatar === "explorer-hat" ? "avatar.explorerHat" : `avatar.${avatar}`)}
            kind="quiet"
            onPress={() => select({ avatar })}
          />
        </View>
      ))}
    </>
  );
}
function EarnedChoices({
  items,
  kind,
  me,
  select,
}: {
  items: LockerEntry[];
  kind: ProfileItem["kind"];
  me: import("#src/auth/player.tsx").Me;
  select: (patch: ProfilePatch) => void;
}) {
  const { t, language } = useI18n();
  return (
    <>
      {items
        .filter((row) => row.item.kind === kind)
        .map((row) => (
          <View key={row.item.id} style={{ gap: 4 }}>
            {kind === "title" ? null : (
              <Avatar
                name={me.avatar}
                username={me.username}
                size={64}
                equipment={{ ...EMPTY_EQUIPMENT, [kind]: row.item }}
              />
            )}
            <Button
              label={row.item.name[language]}
              kind="quiet"
              onPress={() => select({ [`${kind}Id`]: row.item.id })}
            />
            <AppText muted>{t("locker.fromLevel", { level: row.source.level })}</AppText>
          </View>
        ))}
      {items.every((row) => row.item.kind !== kind) ? (
        <AppText muted>{t("locker.empty")}</AppText>
      ) : null}
    </>
  );
}
function LockerChoices({
  locker,
  kind,
  me,
  select,
}: {
  locker: ReturnType<typeof useLocker>;
  kind: ProfileItem["kind"];
  me: import("#src/auth/player.tsx").Me;
  select: (patch: ProfilePatch) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {kind === "character" ? (
        <StarterChoices username={me.username} select={select} />
      ) : (
        <Button
          label={t("locker.clear")}
          kind="quiet"
          onPress={() => select({ [`${kind}Id`]: null })}
        />
      )}
      {locker.items === null && !locker.failed ? <AppText>{t("common.loading")}</AppText> : null}
      {locker.items === null ? null : (
        <EarnedChoices items={locker.items} kind={kind} me={me} select={select} />
      )}
      {locker.failed ? (
        <>
          <AppText accessibilityRole="alert">{t("locker.failed")}</AppText>
          <Button label={t("common.retry")} onPress={locker.retry} />
        </>
      ) : null}
      {locker.cursor === null ? null : (
        <Button
          label={t("locker.more")}
          disabled={locker.busy}
          onPress={() => void locker.more()}
        />
      )}
    </>
  );
}
export function LockerScreen() {
  const { state } = usePlayer();
  const { t, language } = useI18n();
  const me = state.status === "signed_in" ? state.me : undefined;
  const locker = useLocker(me?.id);
  const model = useAppearance(me, locker);
  const [kind, setKind] = useState<ProfileItem["kind"]>("character");
  return (
    <Screen title={t("locker.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {me === undefined ? (
          <ProfileGate />
        ) : (
          <>
            <Avatar
              name={model.draft.avatar ?? me.avatar}
              username={me.username}
              equipment={model.preview}
              size={96}
            />
            {model.preview.title === null ? null : (
              <AppText>{model.preview.title.name[language]}</AppText>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["character", "frame", "title"] as const).map((slot) => (
                <Button
                  key={slot}
                  label={t(slot === "title" ? "locker.titleTab" : `locker.${slot}`)}
                  kind={kind === slot ? "primary" : "quiet"}
                  onPress={() => {
                    setKind(slot);
                    model.select({});
                  }}
                />
              ))}
            </View>
            <LockerChoices locker={locker} kind={kind} me={me} select={model.select} />
            <Problem problem={model.problem} />
            {model.saved ? (
              <AppText accessibilityLiveRegion="polite">{t("locker.saved")}</AppText>
            ) : null}
            <Button
              label={t("locker.equip")}
              disabled={model.busy || Object.keys(model.draft).length === 0}
              onPress={() => void model.save()}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
