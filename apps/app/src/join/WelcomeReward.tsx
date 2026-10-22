import { formatNumber } from "@questify/shared";
import { useEffect, useState } from "react";
import { AppText } from "#src/components/AppText.tsx";
import { CountingNumber, PopIn, SpinningCoin } from "#src/components/motion.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The welcome reward's moment (FR-136): the coin, then the amount counting up into the balance. Shown once, for the
 * join that granted it; without motion the amount simply appears.
 */
export function WelcomeReward({ points }: Readonly<{ points: number }>) {
  const { t, language } = useI18n();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(points);
  }, [points]);
  return (
    <PopIn>
      <SpinningCoin size={96} />
      <AppText variant="title">{t("history.welcome")}</AppText>
      <CountingNumber
        value={shown}
        variant="display"
        format={(value) => `‎+${formatNumber(value, language)}`}
      />
    </PopIn>
  );
}
