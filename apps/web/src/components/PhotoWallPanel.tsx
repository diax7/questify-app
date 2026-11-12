"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  addPick,
  morePhotos,
  movePick,
  pickerOf,
  removePick,
  WALL_MAX,
  type PickerPhoto,
} from "#src/lib/photo-wall.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { RemotePhoto } from "#src/ui/RemotePhoto.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Card, CardList, Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;
type Translate = ReturnType<typeof useTranslator>;

/** One photo in a list: the picture and its quest's title. */
function PhotoCard({
  photo,
  language,
  t,
  children,
}: Readonly<{ photo: PickerPhoto; language: Language; t: Translate; children: React.ReactNode }>) {
  return (
    <Card as="li">
      <RemotePhoto src={photo.url} alt={t("photo.alt")} expired={t("photo.expired")} />
      <Muted>
        <span dir="auto">{textFor(photo.questTitle, language)}</span>
      </Muted>
      <Toolbar>{children}</Toolbar>
    </Card>
  );
}

/** The picked photos in their order, each with Up, Down and Remove. */
function PickedList({
  language,
  picked,
  busy,
  change,
}: Readonly<{
  language: Language;
  picked: readonly PickerPhoto[];
  busy: boolean;
  change: (next: readonly PickerPhoto[]) => void;
}>) {
  const t = useTranslator(language);
  if (picked.length === 0) return <Muted>{t("photoWall.none")}</Muted>;
  return (
    <CardList>
      {picked.map((photo, index) => (
        <PhotoCard key={photo.submissionId} photo={photo} language={language} t={t}>
          <Button
            variant="quiet"
            disabled={busy || index === 0}
            aria-label={t("photoWall.up", { number: String(index + 1) })}
            onClick={() => change(movePick(picked, index, -1))}
          >
            <span aria-hidden="true">↑</span>
          </Button>
          <Button
            variant="quiet"
            disabled={busy || index === picked.length - 1}
            aria-label={t("photoWall.down", { number: String(index + 1) })}
            onClick={() => change(movePick(picked, index, 1))}
          >
            <span aria-hidden="true">↓</span>
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => change(removePick(picked, photo.submissionId))}
          >
            {t("photoWall.remove")}
          </Button>
        </PhotoCard>
      ))}
    </CardList>
  );
}

/** The picker's reading and its pages; `more` reads the next page. */
function usePicker(api: string, language: Language) {
  const t = useTranslator(language);
  const [picked, setPicked] = useState<readonly PickerPhoto[] | null>(null);
  const [candidates, setCandidates] = useState<readonly PickerPhoto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    async (after: string | null) => {
      const result = await requestJson("GET", after === null ? api : `${api}?cursor=${after}`);
      const read = result.ok ? pickerOf(result.body) : undefined;
      if (read === undefined) {
        setProblem(t("photoWall.loadFailed"));
        return;
      }
      if (after === null) setPicked(read.picked);
      setCandidates((shown) =>
        after === null ? read.candidates : morePhotos(shown, read.candidates),
      );
      setCursor(read.cursor);
    },
    [api, t],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return {
    picked,
    setPicked,
    candidates,
    cursor,
    more: () => void load(cursor),
    problem,
    setProblem,
  };
}

/**
 * The photo wall's picker (T-504b, FR-636), shown on the Big screen page while the photo scene is offered (a server
 * with a photo bucket): the approved photos whose owners allowed the screen, newest first, and the wall in order (at
 * most 20). Save replaces the wall; a photo withdrawn, rejected or held leaves it by itself. No player's name is shown.
 */
export function PhotoWallPanel({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const api = `/v1/organizers/${organizerId}/events/${eventId}/photo-wall`;
  const { picked, setPicked, candidates, cursor, more, problem, setProblem } = usePicker(
    api,
    language,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (wall: readonly PickerPhoto[]) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson(
      "PUT",
      api,
      { submissionIds: wall.map((one) => one.submissionId) },
      { "idempotency-key": crypto.randomUUID() },
    );
    setBusy(false);
    if (result.ok) setNotice(t("photoWall.saved"));
    else setProblem(describeProblem(result.body, language, t).text);
  };
  const wall = picked ?? [];
  const open = candidates.filter((one) => !wall.some((p) => p.submissionId === one.submissionId));
  return (
    <Section title={t("photoWall.title")}>
      <Notes
        problem={problem}
        notice={notice}
        loading={picked === null && problem === null}
        language={language}
      />
      <PickedList language={language} picked={wall} busy={busy} change={setPicked} />
      <Toolbar>
        <Button
          variant="primary"
          disabled={busy || picked === null}
          onClick={() => void save(wall)}
        >
          {t("photoWall.save")}
        </Button>
      </Toolbar>
      <Section title={t("photoWall.candidates")}>
        {open.length === 0 ? <Muted>{t("photoWall.empty")}</Muted> : null}
        <CardList>
          {open.map((photo) => (
            <PhotoCard key={photo.submissionId} photo={photo} language={language} t={t}>
              <Button
                disabled={busy || wall.length >= WALL_MAX}
                onClick={() => setPicked(addPick(wall, photo))}
              >
                {t("photoWall.add")}
              </Button>
            </PhotoCard>
          ))}
        </CardList>
        {cursor === null ? null : (
          <Toolbar>
            <Button variant="quiet" disabled={busy} onClick={more}>
              {t("photoWall.more")}
            </Button>
          </Toolbar>
        )}
      </Section>
    </Section>
  );
}
