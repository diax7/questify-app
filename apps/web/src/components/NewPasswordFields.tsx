"use client";

import type { Language } from "@questify/shared";
import { PasswordInput } from "#src/components/PasswordInput.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { Muted } from "#src/ui/Feedback.tsx";

export const NEW_PASSWORD_FIELD = "newPassword";
export const CONFIRM_PASSWORD_FIELD = "confirmPassword";

/** The new password twice, with the rules shown before typing (they are the API's: password.ts). */
export function NewPasswordFields({
  language,
  disabled,
  problemId,
}: Readonly<{ language: Language; disabled: boolean; problemId?: string | undefined }>) {
  const t = translatorFor(language);
  const describedBy = ["password-rules", problemId].filter(Boolean).join(" ");
  return (
    <>
      <Muted id="password-rules">{t("staff.passwordRules")}</Muted>
      <PasswordInput
        language={language}
        name={NEW_PASSWORD_FIELD}
        label={t("staff.newPassword")}
        autoComplete="new-password"
        disabled={disabled}
        describedBy={describedBy}
      />
      <PasswordInput
        language={language}
        name={CONFIRM_PASSWORD_FIELD}
        label={t("staff.confirmPassword")}
        autoComplete="new-password"
        disabled={disabled}
        describedBy={problemId}
      />
    </>
  );
}

/** The two typed passwords, or undefined when they differ. */
export function readNewPassword(form: FormData): string | undefined {
  const password = String(form.get(NEW_PASSWORD_FIELD) ?? "");
  return password === String(form.get(CONFIRM_PASSWORD_FIELD) ?? "") ? password : undefined;
}
