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
import { Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input, Select } from "#src/ui/Field.tsx";
import { infoTip } from "#src/ui/info.tsx";

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
    <Field label={label}>
      <Input
        dir={key.endsWith("Ar") ? "rtl" : "ltr"}
        lang={key.endsWith("Ar") ? "ar" : "en"}
        maxLength={max}
        value={draft[key]}
        disabled={disabled}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <>
      <FieldGroup layout="columns">
        {text("nameAr", t("events.field.nameAr"), 120)}
        {text("nameEn", t("events.field.nameEn"), 120)}
      </FieldGroup>
      <FieldGroup layout="columns">
        <Field label={t("events.field.kind")}>
          <Select
            value={draft.kind}
            disabled={disabled}
            onChange={(event) => change({ kind: event.target.value as EventDraft["kind"] })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`events.kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGroup>
      <FieldGroup layout="columns">
        {text("venueAr", t("events.field.venueAr"), 200)}
        {text("venueEn", t("events.field.venueEn"), 200)}
      </FieldGroup>
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
function EventCityField({
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
  const note = locked
    ? { help: t("events.city.locked") }
    : { info: infoTip(t, "events.city.hint") };
  return (
    <FieldGroup layout="columns">
      <Field label={t("events.field.city")} {...note}>
        <Select
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
        </Select>
      </Field>
      {failed ? (
        <Notice role="alert" tone="danger">
          {t("events.city.failed")}
        </Notice>
      ) : null}
    </FieldGroup>
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
    <FieldGroup
      legend={t("events.field.interests")}
      help={full ? t("events.interests.full") : undefined}
      info={infoTip(t, "events.interests.hint")}
      layout="choiceGrid"
    >
      {interestChoices(interests, draft.interests).map((interest) => {
        const ticked = draft.interests.includes(interest.id);
        return (
          <Checkbox
            key={interest.id}
            label={interestName(interest, language)}
            checked={ticked}
            disabled={disabled || (full && !ticked)}
            onChange={() => change({ interests: toggleInterest(draft.interests, interest.id) })}
          />
        );
      })}
      {failed ? (
        <Notice role="alert" tone="danger">
          {t("events.interests.failed")}
        </Notice>
      ) : null}
    </FieldGroup>
  );
}

/** Where and about what: the event's city and its interests, which decide who "Suggested for you" shows it to. */
export function EventPlaceFields(props: FieldProps & Readonly<{ status: EventStatus }>) {
  return (
    <>
      <EventCityField {...props} />
      <EventInterestsField {...props} />
    </>
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
    <FieldGroup
      legend={t("events.venuePin.title")}
      info={infoTip(t, "events.venuePin.help")}
      layout="columns"
    >
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
    </FieldGroup>
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
    <Field label={t(`events.field.${key}`)}>
      <Input
        type="datetime-local"
        dir="ltr"
        required
        value={draft[key]}
        disabled={disabled || locked}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </Field>
  );
  const timesHint = finished ? t("events.endedHint") : started ? t("events.liveHint") : undefined;
  return (
    <>
      <FieldGroup layout="columns">
        <Field label={t("events.field.timezone")}>
          <Select
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
          </Select>
        </Field>
      </FieldGroup>
      <FieldGroup layout="columns" help={timesHint}>
        {time("startsAt", started || finished)}
        {time("endsAt", finished)}
      </FieldGroup>
      <FieldGroup layout="columns">
        <Field
          label={t("events.field.dayStartHour")}
          info={infoTip(t, "events.field.dayStartHint")}
        >
          <Input
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
        </Field>
      </FieldGroup>
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
      <FieldGroup layout="columns">
        <Field label={t("events.field.access")}>
          <Select
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
          </Select>
        </Field>
      </FieldGroup>
      <FieldGroup legend={t("events.field.joinMethods")} layout="choiceGrid">
        {JOIN_METHODS.map((method) => (
          <Checkbox
            key={method}
            label={t(JOIN_LABELS[method])}
            checked={draft.joinMethods.includes(method)}
            disabled={disabled || (method === "public_list" && draft.access !== "public")}
            onChange={(event) => toggle(method, event.target.checked)}
          />
        ))}
      </FieldGroup>
    </>
  );
}
