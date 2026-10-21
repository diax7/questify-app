import { Stack, useLocalSearchParams } from "expo-router";
import { EventProvider } from "#src/event/EventContext.tsx";

/** Inside one event: its tabs, with the ranking and the event's information as screens over them (T-113). */
export default function EventLayout() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return (
    <EventProvider eventId={eventId}>
      <Stack screenOptions={{ headerShown: false }} />
    </EventProvider>
  );
}
