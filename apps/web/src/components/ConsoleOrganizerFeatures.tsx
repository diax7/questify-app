"use client";

import type { Language, MessageKey, OrganizerFeatureRow } from "@questify/shared";
import { useState } from "react";
import { CatalogState } from "#src/components/CatalogParts.tsx";
import { keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import { nameKeyOf } from "#src/lib/console-switches.ts";
import {
  OVERRIDE_CHOICES,
  bodyOf,
  choiceOf,
  organizerFeaturePath,
  organizerFeaturesPath,
  readOrganizerFeatures,
  type OverrideChoice,
} from "#src/lib/console-organizer-features.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

const CHOICE_KEYS = {
  platform: "console.organizer.features.platform",
  off: "console.organizer.features.off",
  on: "console.organizer.features.on",
} as const satisfies Record<OverrideChoice, MessageKey>;

function FeatureCard({
  language,
  row,
  busy,
  choose,
}: Readonly<{
  language: Language;
  row: OrganizerFeatureRow;
  busy: boolean;
  choose: (choice: OverrideChoice) => void;
}>) {
  const t = translatorFor(language);
  const nameKey = nameKeyOf("feature", row.key);
  const name = nameKey === undefined ? row.key : t(nameKey);
  return (
    <li className={styles.card} data-testid="override-card" data-feature={row.key}>
      <div className={styles.head}>
        <span className={styles.name}>
          {name}
          <Badge tone={row.platformEnabled ? "success" : "neutral"}>
            {t(
              row.platformEnabled
                ? "console.organizer.features.platformOn"
                : "console.organizer.features.platformOff",
            )}
          </Badge>
          {row.override === null ? null : (
            <Badge tone={row.effective ? "info" : "danger"}>
              {t(
                row.effective
                  ? "console.organizer.features.nowOn"
                  : "console.organizer.features.nowOff",
              )}
            </Badge>
          )}
        </span>
      </div>
      <Field label={t("console.organizer.features.for", { name })}>
        <Select
          value={choiceOf(row.override)}
          disabled={busy}
          data-field={row.key}
          onChange={(event) => choose(event.target.value as OverrideChoice)}
        >
          {OVERRIDE_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {t(CHOICE_KEYS[choice])}
            </option>
          ))}
        </Select>
      </Field>
    </li>
  );
}

/**
 * One organizer's feature overrides in the console (T-711, FR-1826): for each feature an override can act on, the
 * platform's switch and Questify's choice for this organizer (like the platform, Off, or On). A choice saves at once and the
 * list is read again, so the page shows what the database holds now. Platform admins only.
 */
export function OrganizerFeaturesPanel({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(
    organizerFeaturesPath(organizerId),
    readOrganizerFeatures,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  const choose = (key: string, choice: OverrideChoice) => {
    const body = bodyOf(choice);
    const path = organizerFeaturePath(organizerId, key);
    void write.run(
      () =>
        body === null
          ? requestJson("DELETE", path, undefined, keyed())
          : requestJson("PUT", path, body, keyed()),
      t("console.catalog.saved"),
    );
  };
  return (
    <Section title={t("console.organizer.features")} level={3}>
      <CatalogState language={language} catalog={{ state, reload, notice, problem: write.problem }}>
        {(view) => (
          <ul className={styles.cards}>
            {view.features.map((row) => (
              <FeatureCard
                key={JSON.stringify(row)}
                language={language}
                row={row}
                busy={write.busy}
                choose={(choice) => choose(row.key, choice)}
              />
            ))}
          </ul>
        )}
      </CatalogState>
    </Section>
  );
}
