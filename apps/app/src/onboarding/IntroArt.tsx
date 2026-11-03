import type { Theme } from "@questify/shared";
import { useEffect, useRef } from "react";
import { Animated, Easing, Image, type ImageSourcePropType } from "react-native";
import { useReduceMotion } from "#src/components/motion.tsx";
import type { CardArt } from "#src/onboarding/intro-flow.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The brand's 3D icons the app already ships, until the mascot is chosen (Q-069, ADR-013). */
const IMAGES: Readonly<Record<CardArt, ImageSourcePropType>> = {
  compass: require("#assets/games/cards/compass.png"),
  steps: require("#assets/achievements/ach-first-steps.png"),
  crown: require("#assets/currency/crownCoin.png"),
  gift: require("#assets/games/cards/gift.png"),
};

const SIZE = 168;
const ICON = 124;

/**
 * A card's picture on a gold-rimmed medallion. It pops in when the card changes and floats gently while the card
 * shows; with the phone's Reduce Motion on, it stands still. Decorative: the card's title says what it is about.
 */
export function IntroArt({ art }: Readonly<{ art: CardArt }>) {
  const styles = useThemedStyles(makeStyles);
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduce !== false) {
      scale.setValue(1);
      lift.setValue(0);
      return;
    }
    scale.setValue(0.6);
    const pop = Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true });
    const float = Animated.loop(
      Animated.sequence([
        Animated.timing(lift, {
          toValue: -6,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(lift, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    pop.start();
    float.start();
    return () => {
      pop.stop();
      float.stop();
    };
  }, [art, reduce, scale, lift]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.medallion, { transform: [{ translateY: lift }, { scale }] }]}
    >
      <Image source={IMAGES[art]} style={styles.icon} resizeMode="contain" />
    </Animated.View>
  );
}

const makeStyles = (theme: Theme) => ({
  medallion: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 4,
    borderColor: theme.colors.navigationActive,
    backgroundColor: theme.colors.background,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  icon: { width: ICON, height: ICON },
});
