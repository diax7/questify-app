import { formatNumber, joinFieldLabel } from "@questify/shared";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Field } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ANSWER_MAX, type Typed } from "#src/join/answers.ts";
import type { JoinRules } from "#src/join/join-api.ts";

/**
 * What the card says about joining (T-212): the locks in plain words, the welcome amount, and the join fields with
 * their required marks (FR-130). `pointed` is the field the app or the API says needs filling.
 */
export function JoinForm({
  rules,
  typed,
  onType,
  pointed,
  showLocks = true,
}: Readonly<{
  rules: JoinRules;
  typed: Typed;
  onType: (typed: Typed) => void;
  pointed: string | undefined;
  /** An invited player passes both locks, so their card leaves them out. */
  showLocks?: boolean;
}>) {
  const { t, language } = useI18n();
  return (
    <View style={{ gap: 12 }}>
      {showLocks && rules.guestListOnly ? <AppText>{t("joinCard.inviteOnly")}</AppText> : null}
      {showLocks && rules.emailDomains.length > 0 ? (
        <AppText>
          {t("joinCard.domains", {
            // Domains read left to right inside an Arabic sentence.
            domains: rules.emailDomains.map((domain) => `⁦@${domain}⁩`).join(", "),
          })}
        </AppText>
      ) : null}
      {rules.welcomePoints === null ? null : (
        <AppText>
          {t("joinCard.welcome", { points: formatNumber(rules.welcomePoints, language) })}
        </AppText>
      )}
      {rules.fields.map((field) => {
        const name = joinFieldLabel(field, language);
        return (
          <View key={field.id} style={{ gap: 4 }}>
            <Field
              label={field.required ? name : `${name} ${t("joinCard.optional")}`}
              value={typed[field.id] ?? ""}
              maxLength={ANSWER_MAX}
              autoComplete={field.kind === "full_name" ? "name" : "off"}
              textContentType={field.kind === "full_name" ? "name" : "none"}
              onChangeText={(value) => onType({ ...typed, [field.id]: value })}
              accessibilityHint={pointed === field.id ? t("joinCard.fillField") : undefined}
            />
            {pointed === field.id ? (
              <AppText accessibilityRole="alert">{t("joinCard.fillField")}</AppText>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
