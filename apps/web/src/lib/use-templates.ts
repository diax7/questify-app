"use client";

import { templateListSchema, type TemplateView } from "@questify/shared";
import { useEffect, useState } from "react";
import { requestJson } from "#src/lib/post-json.ts";

export type TemplatesState = Readonly<{
  templates: readonly TemplateView[];
  status: "loading" | "ready" | "failed";
}>;

/**
 * The templates the picker offers (FR-1015), read once per page from the organizer's list. A refused or damaged answer
 * is `failed`, which leaves "Start blank" as the only choice: a template is never required to make an event.
 */
export function useTemplates(organizerId: string): TemplatesState {
  const [state, setState] = useState<TemplatesState>({ templates: [], status: "loading" });
  useEffect(() => {
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/event-templates`).then((result) => {
      if (!current) {
        return;
      }
      const parsed = templateListSchema.safeParse(result.body);
      setState(
        result.ok && parsed.success
          ? { templates: parsed.data.templates, status: "ready" }
          : { templates: [], status: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [organizerId]);
  return state;
}
