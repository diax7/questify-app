import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { capabilities } from "#src/platform/current.ts";
import { OperatorProvider } from "#src/operator/OperatorContext.tsx";

/** Operator mode in one event (FR-907): its own tabs, with the station scanner over them (T-205). */
export default function OperatorLayout() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  // Staff work is done on a phone: in the browser every operator screen leads back to Home (T-803).
  if (!capabilities.operatorTools) {
    return <Redirect href="/home" />;
  }
  return (
    <OperatorProvider eventId={eventId}>
      <Stack screenOptions={{ headerShown: false }} />
    </OperatorProvider>
  );
}
