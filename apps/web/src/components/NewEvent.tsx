"use client";

import type { Language, TemplateView } from "@questify/shared";
import { useState } from "react";
import { EventForm } from "#src/components/EventForm.tsx";
import { TemplatePicker } from "#src/components/TemplatePicker.tsx";

/**
 * A new event (FR-1001, FR-1015): the "Start from a template" picker above the details form, with Start blank chosen
 * until a template is. The chosen template's key goes with the create request, which fills the draft in one transaction.
 */
export function NewEvent({
  language,
  organizerId,
  myRole,
}: Readonly<{ language: Language; organizerId: string; myRole: "owner" | "editor" }>) {
  const [template, setTemplate] = useState<TemplateView | null>(null);
  return (
    <EventForm
      language={language}
      organizerId={organizerId}
      myRole={myRole}
      template={template?.key}
      intro={
        <TemplatePicker
          language={language}
          organizerId={organizerId}
          value={template?.key ?? null}
          onChange={setTemplate}
        />
      }
    />
  );
}
