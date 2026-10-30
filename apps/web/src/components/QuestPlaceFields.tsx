import { PLACE_RADIUS, type Language } from "@questify/shared";
import { NumberField } from "#src/components/NumberField.tsx";
import { isRadius, pinIsValid, pinTyped } from "#src/lib/coordinates.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { QuestDraft } from "#src/lib/quests.ts";
import { FieldGroup } from "#src/ui/Field.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

/**
 * A spot quest's place (T-303b): a pin typed as two numbers and a radius in metres. Optional on a scan or challenge
 * quest, where it lets the platform notice impossibly fast moves between spots; required on a location quest, where
 * players check in inside the circle. The form checks it before it sends (`questProblem`).
 */
export function QuestPlaceFields({
  language,
  draft,
  disabled,
  change,
}: Readonly<{
  language: Language;
  draft: QuestDraft;
  disabled: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>) {
  const t = translatorFor(language);
  const required = draft.type === "location";
  const typed = pinTyped(draft.placeLat, draft.placeLng);
  const pinBad = !pinIsValid(draft.placeLat, draft.placeLng);
  const radiusBad = typed && !isRadius(draft.placeRadius, PLACE_RADIUS.min, PLACE_RADIUS.max);
  return (
    <FieldGroup
      legend={t("quests.place.title")}
      info={
        <InfoTip label={t("common.info")}>
          {t(required ? "quests.place.helpLocation" : "quests.place.help")}
        </InfoTip>
      }
      layout="choices"
    >
      <FieldGroup layout="columns">
        <NumberField
          label={t("quests.place.lat")}
          decimal
          disabled={disabled}
          value={draft.placeLat}
          invalid={pinBad || (required && draft.placeLat.trim() === "")}
          change={(placeLat) => change({ placeLat })}
        />
        <NumberField
          label={t("quests.place.lng")}
          decimal
          disabled={disabled}
          value={draft.placeLng}
          invalid={pinBad || (required && draft.placeLng.trim() === "")}
          change={(placeLng) => change({ placeLng })}
        />
        <NumberField
          label={t("quests.place.radius")}
          disabled={disabled}
          value={draft.placeRadius}
          invalid={radiusBad}
          change={(placeRadius) => change({ placeRadius })}
        />
      </FieldGroup>
    </FieldGroup>
  );
}
