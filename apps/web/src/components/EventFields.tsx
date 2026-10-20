"use client";

import { isTimeZone, zoneLabel, type Language } from "@questify/shared";
import { useEffect, useMemo, useState } from "react";
import {
  ACCESS,
  COMMON_ZONES,
  JOIN_METHODS,
  KINDS,
  type EventDraft,
  type EventStatus,
} from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type FieldProps = Readonly<{
  language: Language;
  draft: EventDraft;
  disabled: boolean;
  change: (patch: Partial<EventDraft>) => void;
}>;

const JOIN_LABELS = {
  code: "events.join.code",
  qr: "events.join.qr",
  link: "events.join.link",
  public_list: "events.join.publicList",
} as const;

/** Names, kind and venue: each name or venue in either language, at least one name. */
export function EventIdentityFields({ language, draft, disabled, change }: FieldProps) {
  const t = translatorFor(language);
  const text = (key: "nameAr" | "nameEn" | "venueAr" | "venueEn", label: string, max: number) => (
    <label className={styles.field}>
      {label}
      <input
        className={styles.input}
        dir={key.endsWith("Ar") ? "rtl" : "ltr"}
        lang={key.endsWith("Ar") ? "ar" : "en"}
        maxLength={max}
        value={draft[key]}
        disabled={disabled}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </label>
  );
  return (
    <>
      {text("nameAr", t("events.field.nameAr"), 120)}
      {text("nameEn", t("events.field.nameEn"), 120)}
      <p className={styles.muted}>{t("events.field.nameHint")}</p>
      <label className={styles.field}>
        {t("events.field.kind")}
        <select
          className={styles.input}
          value={draft.kind}
          disabled={disabled}
          onChange={(event) => change({ kind: event.target.value as EventDraft["kind"] })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`events.kind.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {text("venueAr", t("events.field.venueAr"), 200)}
      {text("venueEn", t("events.field.venueEn"), 200)}
    </>
  );
}

/**
 * The region's common zones first, then every zone this browser knows, and the event's own even if unknown here. The
 * full list arrives after mounting: the server's zone data may differ from the browser's, and the first render must
 * match on both.
 */
function useZones(current: string): string[] {
  const [known, setKnown] = useState<readonly string[]>([]);
  useEffect(() => {
    setKnown(
      Intl.supportedValuesOf("timeZone").filter(
        (zone) => isTimeZone(zone) && !(COMMON_ZONES as readonly string[]).includes(zone),
      ),
    );
  }, []);
  return useMemo(() => {
    const zones: string[] = [...COMMON_ZONES, ...known];
    return zones.includes(current) ? zones : [current, ...zones];
  }, [current, known]);
}

/**
 * The zone, the times in it, and the hour an event day starts. Once the event is live only its end may move later;
 * once it has ended nothing here changes (the API enforces both; this only says so up front).
 */
export function EventTimeFields({
  language,
  draft,
  disabled,
  change,
  status,
}: FieldProps & Readonly<{ status: EventStatus }>) {
  const t = translatorFor(language);
  const zones = useZones(draft.timezone);
  const started = status === "live";
  const finished = status === "ended" || status === "archived";
  const time = (key: "startsAt" | "endsAt", locked: boolean) => (
    <label className={styles.field}>
      {t(`events.field.${key}`)}
      <input
        className={styles.input}
        type="datetime-local"
        dir="ltr"
        required
        value={draft[key]}
        disabled={disabled || locked}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </label>
  );
  return (
    <>
      <label className={styles.field}>
        {t("events.field.timezone")}
        <select
          className={styles.input}
          dir="ltr"
          value={draft.timezone}
          disabled={disabled || started || finished}
          onChange={(event) => change({ timezone: event.target.value })}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {`${zone} (${zoneLabel(zone, language)})`}
            </option>
          ))}
        </select>
      </label>
      {time("startsAt", started || finished)}
      {time("endsAt", finished)}
      <p className={styles.muted}>
        {finished
          ? t("events.endedHint")
          : started
            ? t("events.liveHint")
            : t("events.field.timesHint")}
      </p>
      <label className={styles.field}>
        {t("events.field.dayStartHour")}
        <input
          className={styles.input}
          type="number"
          dir="ltr"
          min={0}
          max={23}
          required
          value={draft.dayStartHour}
          disabled={disabled || started || finished}
          onChange={(event) => {
            // An emptied field keeps the last hour rather than turning into midnight.
            if (event.target.value !== "") {
              change({ dayStartHour: Number(event.target.value) });
            }
          }}
        />
      </label>
      <p className={styles.muted}>{t("events.field.dayStartHint")}</p>
    </>
  );
}

/** Who can find the event and how people join; the public list only for an event everyone can find. */
export function EventAccessFields({ language, draft, disabled, change }: FieldProps) {
  const t = translatorFor(language);
  const toggle = (method: EventDraft["joinMethods"][number], on: boolean) =>
    change({
      joinMethods: on
        ? [...draft.joinMethods, method]
        : draft.joinMethods.filter((item) => item !== method),
    });
  return (
    <>
      <label className={styles.field}>
        {t("events.field.access")}
        <select
          className={styles.input}
          value={draft.access}
          disabled={disabled}
          onChange={(event) => {
            const access = event.target.value as EventDraft["access"];
            change({
              access,
              joinMethods:
                access === "public"
                  ? draft.joinMethods
                  : draft.joinMethods.filter((item) => item !== "public_list"),
            });
          }}
        >
          {ACCESS.map((access) => (
            <option key={access} value={access}>
              {t(`events.access.${access}`)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.choices}>
        <legend>{t("events.field.joinMethods")}</legend>
        {JOIN_METHODS.map((method) => (
          <label key={method} className={styles.check}>
            <input
              type="checkbox"
              checked={draft.joinMethods.includes(method)}
              disabled={disabled || (method === "public_list" && draft.access !== "public")}
              onChange={(event) => toggle(method, event.target.checked)}
            />
            <span>{t(JOIN_LABELS[method])}</span>
          </label>
        ))}
      </fieldset>
    </>
  );
}
