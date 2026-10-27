import { parseJoinLink, parseRehearsalCode } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** A typed join code or link, for people who cannot use the camera (the center button scans the same codes). */
export function CodeEntry() {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const open = () => {
    const code = parseJoinLink(typed) ?? parseRehearsalCode(typed);
    if (code === null) {
      setWrong(true);
      return;
    }
    setWrong(false);
    router.push({ pathname: "/join/[code]", params: { code, via: "code" } });
  };
  return (
    <>
      <Field
        label={t("home.codeLabel")}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      {wrong ? <AppText accessibilityRole="alert">{t("home.notACode")}</AppText> : null}
      <Button label={t("home.open")} disabled={typed.trim() === ""} onPress={open} />
    </>
  );
}
