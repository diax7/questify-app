import type { LocalizedText } from "@questify/shared";
import { useState } from "react";
import { ScrollView } from "react-native";
import { downloadMyData, type DataExportDeps } from "#src/account/data-export.ts";
import { dataModulesPresent, loadDataModules } from "#src/account/data-export-native.ts";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

const deps: DataExportDeps = {
  session: api.session,
  modulesPresent: dataModulesPresent,
  loadModules: loadDataModules,
  now: () => new Date(),
};

type View = "idle" | "working" | "shared" | "unavailable";

/**
 * Settings → Download my data (FR-1418, T-708): what the file holds and that it is private, then one button. The file
 * goes to the share sheet and the app keeps no copy.
 */
export default function DataExportScreen() {
  const { t } = useI18n();
  const [view, setView] = useState<View>("idle");
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const start = async () => {
    setView("working");
    setProblem(null);
    const result = await downloadMyData(deps);
    if (result.kind === "problem") {
      setProblem(result.message);
      setView("idle");
      return;
    }
    setView(result.kind);
  };
  return (
    <Screen title={t("dataExport.title")}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText>{t("dataExport.intro")}</AppText>
        <AppText muted>{t("dataExport.private")}</AppText>
        <Problem problem={problem} />
        {view === "shared" ? (
          <AppText accessibilityRole="alert">{t("dataExport.done")}</AppText>
        ) : null}
        {view === "unavailable" ? (
          <AppText accessibilityRole="alert">{t("dataExport.unavailable")}</AppText>
        ) : null}
        <Button
          label={t(view === "working" ? "dataExport.working" : "dataExport.start")}
          disabled={view === "working"}
          onPress={() => void start()}
        />
      </ScrollView>
    </Screen>
  );
}
