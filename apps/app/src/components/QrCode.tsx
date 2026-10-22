import { useMemo } from "react";
import { View } from "react-native";
import { darkRuns } from "#src/components/qr-runs.ts";

/**
 * A QR code drawn with plain views, black on white in every theme (scanners need that contrast), never mirrored right
 * to left. `size` is its width in points.
 */
export function QrCode({
  text,
  size,
  label,
}: Readonly<{ text: string; size: number; label: string }>) {
  const drawing = useMemo(() => darkRuns(text), [text]);
  const cell = size / drawing.size;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size, backgroundColor: "#ffffff", direction: "ltr" }}
    >
      {drawing.rows.map((runs, y) =>
        runs.map(([x = 0, length = 0]) => (
          <View
            key={`${y}-${x}`}
            style={{
              position: "absolute",
              top: y * cell,
              left: x * cell,
              width: length * cell,
              height: cell,
              backgroundColor: "#000000",
            }}
          />
        )),
      )}
    </View>
  );
}
