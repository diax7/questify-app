"use client";

import {
  changeSetListSchema,
  formatEventTime,
  formatNumber,
  type ChangeSetSummary,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ChangeSetReview } from "#src/components/ChangeSetReview.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Stack } from "#src/ui/Section.tsx";

const STATUS_TONE = { open: "info", applied: "success", closed: "neutral" } as const;

type Loaded = Readonly<{ sets: readonly ChangeSetSummary[]; zone: string }>;

/** The event's change sets and its time zone; "failed" when either could not be read. */
function useChangeSets(base: string): {
  loaded: Loaded | "failed" | undefined;
  reload: () => Promise<void>;
} {
  const [loaded, setLoaded] = useState<Loaded | "failed">();
  const load = useCallback(async () => {
    const [list, event] = await Promise.all([
      requestJson("GET", `${base}/change-sets`),
      requestJson("GET", base),
    ]);
    const parsed = list.ok ? changeSetListSchema.safeParse(list.body) : null;
    const zone = (event.body as { event?: { timezone?: unknown } } | undefined)?.event?.timezone;
    setLoaded(
      parsed?.success === true && typeof zone === "string"
        ? { sets: parsed.data.changeSets, zone }
        : "failed",
    );
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  return { loaded, reload: load };
}

function SetRow({
  language,
  set,
  zone,
  open,
}: Readonly<{ language: Language; set: ChangeSetSummary; zone: string; open: () => void }>) {
  const t = useTranslator(language);
  return (
    <Row
      main={
        <>
          <strong>
            {t("changeSets.made", {
              time: formatEventTime(new Date(set.createdAt), zone, language),
            })}
          </strong>
          <Badge tone={STATUS_TONE[set.status]}>{t(`changeSets.status.${set.status}`)}</Badge>
          <Muted>
            {t("changeSets.items", { count: formatNumber(set.items, language) })} ·{" "}
            {t("changeSets.waiting", { count: formatNumber(set.pending, language) })}
          </Muted>
        </>
      }
    >
      <Button variant="secondary" onClick={open}>
        {t("changeSets.review")}
      </Button>
    </Row>
  );
}

/** The list of sets, or why there is none: still loading, not readable, or empty. */
function SetList({
  language,
  loaded,
  open,
}: Readonly<{
  language: Language;
  loaded: Loaded | "failed" | undefined;
  open: (id: string) => void;
}>) {
  const t = useTranslator(language);
  if (loaded === undefined) {
    return <Muted>{t("common.loading")}</Muted>;
  }
  if (loaded === "failed") {
    return (
      <Notice tone="danger" role="alert">
        {t("changeSets.loadFailed")}
      </Notice>
    );
  }
  return loaded.sets.length === 0 ? (
    <EmptyState>{t("changeSets.empty")}</EmptyState>
  ) : (
    <Rows>
      {loaded.sets.map((set) => (
        <SetRow
          key={set.id}
          language={language}
          set={set}
          zone={loaded.zone}
          open={() => open(set.id)}
        />
      ))}
    </Rows>
  );
}

/**
 * The event's change sets (T-604b, FR-1034, FR-1035): the sets made through the API, newest first, and one opened for
 * review. Sets are made by the API (the future AI assistant), not here; this page reviews, applies and closes them.
 */
export function ChangeSetsPanel({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { loaded, reload } = useChangeSets(base);
  const [opened, setOpened] = useState<string | null>(null);
  if (opened !== null) {
    return (
      <ChangeSetReview
        language={language}
        base={base}
        setId={opened}
        back={() => {
          setOpened(null);
          void reload();
        }}
      />
    );
  }
  return (
    <Stack as="section" aria-labelledby="change-sets-title">
      <PageHeader titleId="change-sets-title" title={t("changeSets.page.title")} />
      <SetList language={language} loaded={loaded} open={setOpened} />
    </Stack>
  );
}
