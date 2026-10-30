"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { Field, InlineControls, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";

type Props = Readonly<{
  language: Language;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  disabled: boolean;
  describedBy?: string | undefined;
  /** A rule the password must meet, said once under the field. */
  help?: string | undefined;
}>;

/** A password field with an eye button that shows or hides it; paste always works (ASVS V6.2.7, V6.2.8). */
export function PasswordInput({
  language,
  name,
  label,
  autoComplete,
  disabled,
  describedBy,
  help,
}: Props) {
  const t = translatorFor(language);
  const [shown, setShown] = useState(false);
  const id = `field-${name}`;
  const described = [help === undefined ? "" : `${id}-help`, describedBy ?? ""]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <Field id={id} label={label} help={help}>
      <InlineControls>
        <Input
          name={name}
          type={shown ? "text" : "password"}
          dir="ltr"
          autoComplete={autoComplete}
          required
          disabled={disabled}
          aria-describedby={described === "" ? undefined : described}
        />
        <IconButton
          icon={shown ? "eyeOff" : "eye"}
          label={shown ? t("staff.hidePassword") : t("staff.showPassword")}
          aria-controls={id}
          onClick={() => setShown((value) => !value)}
        />
      </InlineControls>
    </Field>
  );
}
