import { useEffect, useRef, useState } from "react";
import type { TextVariant } from "@questify/shared";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { AppText } from "#src/components/AppText.tsx";

/**
 * The phone's Reduce Motion setting (FR-408), followed as it changes; undefined until the phone has said. Nothing moves
 * while it is undefined, so a player who turned motion off never sees a first frame of it.
 */
export function useReduceMotion(): boolean | undefined {
  const [reduce, setReduce] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (live) {
          setReduce(value);
        }
      })
      // A phone that cannot say is treated as wanting less motion.
      .catch(() => live && setReduce(true));
    const watcher = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      watcher.remove();
    };
  }, []);
  return reduce;
}

/**
 * A number that counts up or down to each new value it is given (FR-403), in 600 ms, from the value it shows; it first
 * appears at its value, with no count. Without motion it shows each value at once. The caller formats the text, so
 * digits stay Western in both languages; a screen for another event mounts a new one (`key`).
 */
export function CountingNumber({
  value,
  format,
  variant,
}: Readonly<{ value: number; format: (shown: number) => string; variant?: TextVariant }>) {
  const reduce = useReduceMotion();
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const animated = useRef(new Animated.Value(value)).current;
  useEffect(() => {
    const listener = animated.addListener(({ value: now }) => {
      shownRef.current = Math.round(now);
      setShown(shownRef.current);
    });
    return () => animated.removeListener(listener);
  }, [animated]);
  useEffect(() => {
    if (reduce !== false || shownRef.current === value) {
      animated.setValue(value);
      return;
    }
    animated.setValue(shownRef.current);
    const run = Animated.timing(animated, {
      toValue: value,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    run.start();
    return () => run.stop();
  }, [value, reduce, animated]);
  return <AppText variant={variant ?? "body"}>{format(shown)}</AppText>;
}

/**
 * A coin that turns while the server checks a scan (FR-406); still, facing front, without motion. A placeholder glyph
 * until the brand deck's coin exists (ADR-013, Q-103).
 */
export function SpinningCoin({ size = 72 }: Readonly<{ size?: number }>) {
  const reduce = useReduceMotion();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce !== false) {
      turn.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      turn.setValue(0);
    };
  }, [reduce, turn]);
  const rotateY = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ fontSize: size, textAlign: "center", transform: [{ rotateY }] }}
    >
      🪙
    </Animated.Text>
  );
}

/** A celebration that grows in once (FR-406, FR-407); it simply appears without motion. */
export function PopIn({ children }: Readonly<{ children: React.ReactNode }>) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const played = useRef(false);
  useEffect(() => {
    if (reduce !== false || played.current) {
      return;
    }
    played.current = true;
    scale.setValue(0.6);
    Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true }).start();
  }, [reduce, scale]);
  return <Animated.View style={{ transform: [{ scale }], gap: 12 }}>{children}</Animated.View>;
}
