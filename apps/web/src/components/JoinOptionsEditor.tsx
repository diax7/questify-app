"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useRef } from "react";
import { JOIN_OPTION_MAX, JOIN_OPTION_MIN, type OptionDraft } from "#src/lib/joining.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Checkbox, Field, FieldGroup, Input } from "#src/ui/Field.tsx";
import { Card, CardList, Toolbar } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

type Props = Readonly<{
  language: Language;
  /** The field's label, so each option's inputs name the field they belong to. */
  fieldName: string;
  options: readonly OptionDraft[] | null;
  busy: boolean;
  change: (options: OptionDraft[] | null) => void;
}>;

/**
 * A custom field's answer as a choice from a list (ADR-171), which "Who sees what" can target: 2 to 20 options, each
 * named in Arabic, English or both. A saved option that players chose or a rule names cannot be removed (the API
 * answers `join_field_in_use`); a new one can always be added.
 */
export function JoinOptionsEditor({ language, fieldName, options, busy, change }: Props) {
  const t = useTranslator(language);
  const counter = useRef(0);
  const fresh = (): OptionDraft => {
    counter.current += 1;
    return { key: `option-${counter.current}`, id: undefined, ar: "", en: "" };
  };
  const list = options ?? [];
  const set = (index: number, patch: Partial<OptionDraft>) =>
    change(list.map((option, at) => (at === index ? { ...option, ...patch } : option)));

  return (
    <FieldGroup>
      <Checkbox
        checked={options !== null}
        disabled={busy}
        onChange={(ticked) => change(ticked.target.checked ? [fresh(), fresh()] : null)}
        label={t("joinFields.choice")}
        info={
          <InfoTip label={t("common.info")}>
            {t("joinFields.choiceHint", {
              min: formatNumber(JOIN_OPTION_MIN, language),
              max: formatNumber(JOIN_OPTION_MAX, language),
            })}
          </InfoTip>
        }
      />
      {options === null ? null : (
        <>
          <CardList>
            {list.map((option, index) => (
              <Card as="li" key={option.key}>
                <Toolbar>
                  {(["ar", "en"] as const).map((side) => (
                    <Field
                      label={t(side === "ar" ? "joinFields.optionAr" : "joinFields.optionEn", {
                        number: formatNumber(index + 1, language),
                      })}
                    >
                      <Input
                        dir={side === "ar" ? "rtl" : "ltr"}
                        maxLength={60}
                        value={option[side]}
                        disabled={busy}
                        aria-description={fieldName}
                        onChange={(typed) => set(index, { [side]: typed.target.value })}
                      />
                    </Field>
                  ))}
                  <Button
                    variant="quiet"
                    disabled={busy || list.length <= JOIN_OPTION_MIN}
                    onClick={() => change(list.filter((_, at) => at !== index))}
                  >
                    {t("joinFields.removeOption")}
                  </Button>
                </Toolbar>
              </Card>
            ))}
          </CardList>
          {list.length < JOIN_OPTION_MAX ? (
            <Button variant="quiet" disabled={busy} onClick={() => change([...list, fresh()])}>
              {t("joinFields.addOption")}
            </Button>
          ) : null}
        </>
      )}
    </FieldGroup>
  );
}
