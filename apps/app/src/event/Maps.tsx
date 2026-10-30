import { useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { BackButton } from "#src/components/BackButton.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { MapsView } from "#src/event/MapsView.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** The event's maps on a screen of their own, linked from Event Home (FR-821). */
export function MapsScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { t } = useI18n();
  return (
    <Screen title={t("mapsView.title")}>
      <BackButton />
      <ScrollView>
        <MapsView eventId={eventId} />
      </ScrollView>
    </Screen>
  );
}
