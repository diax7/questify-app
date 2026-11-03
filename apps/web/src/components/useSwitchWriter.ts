"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";

export type Writer = Readonly<{
  busy: boolean;
  put: (path: string, body: object) => Promise<boolean>;
  reset: (path: string) => Promise<boolean>;
}>;

/**
 * The writes of the Switches page (T-703, T-703b): a save (`PUT`) and a put-back (`DELETE`), each with an idempotency key,
 * the page read again after either, and the notice or the API's own refusal for the page to show.
 */
export function useSwitchWriter(language: Language, reload: () => Promise<void>) {
  const t = translatorFor(language);
  const [notice, setNotice] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  const writer: Writer = {
    busy: write.busy,
    put: (path, body) =>
      write.run(() => requestJson("PUT", path, body, keyed()), t("console.catalog.saved")),
    reset: (path) =>
      write.run(
        () => requestJson("DELETE", path, undefined, keyed()),
        t("console.catalog.reverted"),
      ),
  };
  return { writer, notice, problem: write.problem };
}
