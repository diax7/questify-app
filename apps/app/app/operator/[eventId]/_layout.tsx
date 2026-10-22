import { Stack, useLocalSearchParams } from "expo-router";
import { OperatorProvider } from "#src/operator/OperatorContext.tsx";

/** Operator mode in one event (FR-907): its own tabs, with the station scanner over them (T-205). */
export default function OperatorLayout() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return (
    <OperatorProvider eventId={eventId}>
      <Stack screenOptions={{ headerShown: false }} />
    </OperatorProvider>
  );
}
