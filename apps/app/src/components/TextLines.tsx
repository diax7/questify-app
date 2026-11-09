import { AppText } from "#src/components/AppText.tsx";
import type { TextLine } from "#src/components/text-lines.ts";

/** The lines of a card, in order, each an AppText with the props its line carries. */
export function TextLines({ lines }: Readonly<{ lines: readonly TextLine[] }>) {
  return (
    <>
      {lines.map((line) => (
        <AppText key={line.key} {...line.props}>
          {line.text}
        </AppText>
      ))}
    </>
  );
}
