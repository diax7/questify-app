"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, InlineControls, Input } from "#src/ui/Field.tsx";

type Props = Readonly<{
  language: Language;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  disabled: boolean;
  describedBy?: string | undefined;
}>;

/** A password field with a show/hide switch; paste always works (ASVS V6.2.7, V6.2.8). */
export function PasswordInput({
  language,
  name,
  label,
  autoComplete,
  disabled,
  describedBy,
}: Props) {
  const t = translatorFor(language);
  const [shown, setShown] = useState(false);
  const id = `field-${name}`;
  return (
    <Field id={id} label={label}>
      <InlineControls>
        <Input
          name={name}
          type={shown ? "text" : "password"}
          dir="ltr"
          autoComplete={autoComplete}
          required
          disabled={disabled}
          aria-describedby={describedBy}
        />
        <Button
          variant="secondary"
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? t("staff.hidePassword") : t("staff.showPassword")}
        </Button>
      </InlineControls>
    </Field>
  );
}
