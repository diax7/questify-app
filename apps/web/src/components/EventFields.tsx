"use client";

import {
  MAX_EVENT_INTERESTS,
  VENUE_RADIUS,
  isTimeZone,
  zoneLabel,
  type City,
  type Interest,
  type Language,
} from "@questify/shared";
import { useEffect, useMemo, useState } from "react";
import { NumberField } from "#src/components/NumberField.tsx";
import { cityChoices, cityName, readCities } from "#src/lib/cities.ts";
import {
  interestChoices,
  interestName,
  readInterests,
  toggleInterest,
} from "#src/lib/interests.ts";
import { isRadius, pinIsValid } from "#src/lib/coordinates.ts";
import {
  ACCESS,
  COMMON_ZONES,
  JOIN_METHODS,
  KINDS,
  type EventDraft,
  type EventStatus,
} from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
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

/** The seeded cities (ADR-277), read once; `failed` when the list could not be read. */
function useCities(): Readonly<{ cities: readonly City[]; failed: boolean }> {
  const [state, setState] = useState<{ cities: readonly City[]; failed: boolean }>({
    cities: [],
    failed: false,
  });
  useEffect(() => {
    let current = true;
    void requestJson("GET", "/v1/cities").then((result) => {
      const cities = result.ok ? readCities(result.body) : undefined;
      if (current) {
        setState({ cities: cities ?? [], failed: cities === undefined });
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return state;
}

/**
 * The event's city, for Questify's city achievements (T-403, ADR-277). An online event has none, so the field is not
 * shown; once the event is live the city is fixed (the API refuses a change with `city_locked`; this says so up front).
 */
export function EventCityField({
  language,
  draft,
  disabled,
  change,
  status,
}: FieldProps & Readonly<{ status: EventStatus }>) {
  const t = translatorFor(language);
  const { cities, failed } = useCities();
  if (draft.kind === "virtual") {
    return null;
  }
  const locked = status === "live" || status === "ended" || status === "archived";
  return (
    <>
      <label className={styles.field}>
        {t("events.field.city")}
        <select
          className={styles.input}
          value={draft.cityId ?? ""}
          disabled={disabled || locked}
          onChange={(event) =>
            change({ cityId: event.target.value === "" ? null : event.target.value })
          }
        >
          <option value="">{t("events.city.none")}</option>
          {cityChoices(cities, draft.cityId).map((city) => (
            <option key={city.id} value={city.id}>
              {cityName(city, language)}
            </option>
          ))}
        </select>
      </label>
      {failed ? (
        <p role="alert" className={styles.alert}>
          {t("events.city.failed")}
        </p>
      ) : null}
      <p className={styles.muted}>{t(locked ? "events.city.locked" : "events.city.hint")}</p>
    </>
  );
}

/** The seeded interests (ADR-319), read once; `failed` when the list could not be read. */
function useInterests(): Readonly<{ interests: readonly Interest[]; failed: boolean }> {
  const [state, setState] = useState<{ interests: readonly Interest[]; failed: boolean }>({
    interests: [],
    failed: false,
  });
  useEffect(() => {
    let current = true;
    void requestJson("GET", "/v1/interests").then((result) => {
      const interests = result.ok ? readInterests(result.body) : undefined;
      if (current) {
        setState({ interests: interests ?? [], failed: interests === undefined });
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return state;
}

/**
 * The event's interests (T-407, ADR-319): up to three, ticked from the catalog. Players who like them see a public
 * event in their "For you" list. Plain checkboxes, so a keyboard and a screen reader reach each one; the ones beyond
 * the limit are disabled, with a sentence that says why.
 */
export function EventInterestsField({ language, draft, disabled, change }: FieldProps) {
  const t = translatorFor(language);
  const { interests, failed } = useInterests();
  const full = draft.interests.length >= MAX_EVENT_INTERESTS;
  return (
    <fieldset className={styles.row}>
      <legend>{t("events.field.interests")}</legend>
      {interestChoices(interests, draft.interests).map((interest) => {
        const ticked = draft.interests.includes(interest.id);
        return (
          <label key={interest.id} className={styles.check}>
            <input
              type="checkbox"
              checked={ticked}
              disabled={disabled || (full && !ticked)}
              onChange={() => change({ interests: toggleInterest(draft.interests, interest.id) })}
            />
            <span>{interestName(interest, language)}</span>
          </label>
        );
      })}
      {failed ? (
        <p role="alert" className={styles.alert}>
          {t("events.interests.failed")}
        </p>
      ) : null}
      <p className={styles.muted}>{t(full ? "events.interests.full" : "events.interests.hint")}</p>
    </fieldset>
  );
}

/**
 * The venue's pin and radius (T-303b): optional, only for the far-from-venue flag. A pin is both numbers or neither;
 * the form checks them before it sends (`venueIsValid`).
 */
export function EventVenuePinFields({ language, draft, disabled, change }: FieldProps) {
  const t = translatorFor(language);
  const pinBad = !pinIsValid(draft.venueLat, draft.venueLng);
  const radiusBad = !isRadius(draft.venueRadius, VENUE_RADIUS.min, VENUE_RADIUS.max);
  return (
    <fieldset className={styles.choices}>
      <legend>{t("events.venuePin.title")}</legend>
      <p className={styles.muted}>{t("events.venuePin.help")}</p>
      <div className={styles.row}>
        <NumberField
          label={t("events.venuePin.lat")}
          decimal
          disabled={disabled}
          value={draft.venueLat}
          invalid={pinBad}
          change={(venueLat) => change({ venueLat })}
        />
        <NumberField
          label={t("events.venuePin.lng")}
          decimal
          disabled={disabled}
          value={draft.venueLng}
          invalid={pinBad}
          change={(venueLng) => change({ venueLng })}
        />
        <NumberField
          label={t("events.venuePin.radius")}
          disabled={disabled}
          value={draft.venueRadius}
          invalid={radiusBad}
          change={(venueRadius) => change({ venueRadius })}
        />
      </div>
    </fieldset>
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
