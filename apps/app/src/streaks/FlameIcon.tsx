import { Image } from "react-native";

/** The brand's flame (`icons/flame.png`). Decorative: the lines beside it say the streak. */
export function FlameIcon({ size }: Readonly<{ size: number }>) {
  return (
    <Image
      accessibilityElementsHidden
      importantForAccessibility="no"
      source={require("#assets/icons/flame.png")}
      resizeMode="contain"
      style={{ width: size, height: size }}
    />
  );
}
