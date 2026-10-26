import { Image } from "react-native";

/** The brand's gem (`currency/gem.png`). Decorative: the count beside it is the label. */
export function GemIcon({ size }: Readonly<{ size: number }>) {
  return (
    <Image
      accessibilityElementsHidden
      importantForAccessibility="no"
      source={require("#assets/currency/gem.png")}
      resizeMode="contain"
      style={{ width: size, height: size }}
    />
  );
}
