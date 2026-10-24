import { useEvent } from "#src/event/EventContext.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { ProfileScreen } from "#src/screens/ProfileScreen.tsx";

export default function EventProfileScreen() {
  const { eventId } = useEvent();
  return <ProfileScreen header={<EventPill />} eventId={eventId} />;
}
