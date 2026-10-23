import { formatNumber, joinFieldLabel, joinOptionLabel, type Theme } from "@questify/shared";
import { Pressable, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Field } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { ANSWER_MAX, type Typed } from "#src/join/answers.ts";
import type { JoinField, JoinRules } from "#src/join/join-api.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** A choice field (ADR-171): one option picked from the organizer's list, as radio buttons. */
function ChoiceField({
  field,
  label,
  chosen,
  onChoose,
}: Readonly<{
  field: JoinField;
  label: string;
  chosen: string | undefined;
  onChoose: (id: string) => void;
}>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={{ gap: 8 }}>
      <AppText variant="label">{label}</AppText>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.options}>
        {(field.options ?? []).map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: option.id === chosen }}
            onPress={() => onChoose(option.id)}
            style={[styles.option, option.id === chosen && styles.chosen]}
          >
            <AppText variant="label">{joinOptionLabel(option, language)}</AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  options: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  option: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  chosen: { borderColor: theme.colors.primaryAction },
});

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
        const label = field.required ? name : `${name} ${t("joinCard.optional")}`;
        return (
          <View key={field.id} style={{ gap: 4 }}>
            {field.options === null ? (
              <Field
                label={label}
                value={typed[field.id] ?? ""}
                maxLength={ANSWER_MAX}
                autoComplete={field.kind === "full_name" ? "name" : "off"}
                textContentType={field.kind === "full_name" ? "name" : "none"}
                onChangeText={(value) => onType({ ...typed, [field.id]: value })}
                accessibilityHint={pointed === field.id ? t("joinCard.fillField") : undefined}
              />
            ) : (
              <ChoiceField
                field={field}
                label={label}
                chosen={typed[field.id]}
                onChoose={(id) => onType({ ...typed, [field.id]: id })}
              />
            )}
            {pointed === field.id ? (
              <AppText accessibilityRole="alert">{t("joinCard.fillField")}</AppText>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
