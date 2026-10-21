import { EventPill } from "#src/event/EventPill.tsx";
import { ProfileScreen } from "#src/screens/ProfileScreen.tsx";

export default function EventProfileScreen() {
  return <ProfileScreen header={<EventPill />} />;
}
