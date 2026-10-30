"use client";

import {
  amenityKey,
  type Language,
  type MapAmenity,
  type TeamMap,
  type TeamMapPin,
} from "@questify/shared";
import { useMemo, useState } from "react";
import { MapBoard } from "#src/components/MapBoard.tsx";
import { MapPinForm } from "#src/components/MapPinForm.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  blankPin,
  mapName,
  pinDraftOf,
  pinLabel,
  thousandthsOf,
  type PinDraft,
} from "#src/lib/maps.ts";
import type { QuestChoice } from "#src/lib/use-maps.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Row, Rows, Section } from "#src/ui/Section.tsx";

export type MapWrites = Readonly<{
  busy: boolean;
  failure: string | null;
  clearFailure: () => void;
  run: (
    method: "POST" | "PUT" | "DELETE",
    suffix: string,
    body: unknown,
    done: () => string,
  ) => Promise<boolean>;
}>;

type Edit = Readonly<{ id: string | null; draft: PinDraft }>;

function MapPinList({
  language,
  pins,
  labelOf,
  busy,
  edit,
  remove,
}: Readonly<{
  language: Language;
  pins: readonly TeamMapPin[];
  labelOf: (pin: TeamMapPin) => string;
  busy: boolean;
  edit: (pin: TeamMapPin) => void;
  remove: (pin: TeamMapPin) => void;
}>) {
  const t = useTranslator(language);
  return (
    <Rows>
      {pins.map((pin) => (
        <Row
          key={pin.id}
          main={
            <>
              <strong>{labelOf(pin)}</strong>
              <span>
                <Badge>{t(`maps.pin.kind.${pin.kind}`)}</Badge>
              </span>
            </>
          }
        >
          <Button variant="quiet" disabled={busy} onClick={() => edit(pin)}>
            {t("maps.pin.edit")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => remove(pin)}>
            {t("maps.page.delete")}
          </Button>
        </Row>
      ))}
    </Rows>
  );
}

/** The map's pins and the board they sit on, with the form for adding and editing one. */
export function MapEditor({
  language,
  map,
  quests,
  pinnedQuestIds,
  writes,
}: Readonly<{
  language: Language;
  map: TeamMap;
  quests: readonly QuestChoice[];
  pinnedQuestIds: ReadonlySet<string>;
  writes: MapWrites;
}>) {
  const t = useTranslator(language);
  const [edit, setEdit] = useState<Edit | null>(null);
  const titles = useMemo(() => new Map(quests.map((quest) => [quest.id, quest.title])), [quests]);
  const amenityName = (amenity: MapAmenity) => t(amenityKey(amenity));
  const labelOf = (pin: TeamMap["pins"][number]) => pinLabel(pin, language, titles, amenityName);
  const editedQuest = edit?.draft.questId ?? "";
  const choices = quests.filter(
    (quest) => !pinnedQuestIds.has(quest.id) || quest.id === editedQuest,
  );
  const base = `/${map.id}/pins`;
  const close = () => {
    setEdit(null);
    writes.clearFailure();
  };
  const place = (spot: { x: number; y: number }) =>
    setEdit((current) => {
      const draft = current?.draft ?? blankPin();
      return {
        id: current?.id ?? null,
        draft: { ...draft, x: String(spot.x / 10), y: String(spot.y / 10) },
      };
    });
  const save = (body: unknown) => {
    const path = edit?.id == null ? base : `${base}/${edit.id}`;
    void writes
      .run(edit?.id == null ? "POST" : "PUT", path, body, () => t("maps.pin.saved"))
      .then((ok) => {
        if (ok) close();
      });
  };
  return (
    <Section title={`${t("maps.page.pins")}: ${mapName(map, language)}`} level={3}>
      <MapBoard
        label={t("maps.page.board", { name: mapName(map, language) })}
        pins={map.pins}
        labelOf={labelOf}
        selectedId={edit?.id ?? null}
        draft={
          edit === null ? null : { x: thousandthsOf(edit.draft.x), y: thousandthsOf(edit.draft.y) }
        }
        onPlace={place}
        onSelect={(pin) => setEdit({ id: pin.id, draft: pinDraftOf(pin) })}
      />
      {edit === null ? (
        <div>
          <Button
            variant="secondary"
            disabled={writes.busy}
            onClick={() => setEdit({ id: null, draft: blankPin() })}
          >
            {t("maps.pin.add")}
          </Button>
        </div>
      ) : (
        <MapPinForm
          key={edit.id ?? "new"}
          language={language}
          draft={edit.draft}
          editing={edit.id !== null}
          quests={choices}
          busy={writes.busy}
          problem={writes.failure}
          change={(key, value) => setEdit({ ...edit, draft: { ...edit.draft, [key]: value } })}
          cancel={close}
          save={save}
        />
      )}
      <MapPinList
        language={language}
        pins={map.pins}
        labelOf={labelOf}
        busy={writes.busy}
        edit={(pin) => setEdit({ id: pin.id, draft: pinDraftOf(pin) })}
        remove={(pin) => {
          void writes.run("DELETE", `${base}/${pin.id}`, undefined, () => t("maps.pin.deleted"));
          if (edit?.id === pin.id) close();
        }}
      />
    </Section>
  );
}
