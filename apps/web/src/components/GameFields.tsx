"use client";

import {
  GAME_ATTEMPTS,
  GAME_LEVEL_KEYS,
  GAME_LEVELS,
  GAME_NAME_KEYS,
  GAME_NAMES,
  LEVELS,
  gameTarget,
  isGameLevel,
  isGameName,
  targetWords,
} from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { NumberField } from "#src/components/NumberField.tsx";
import type { TypeFieldProps } from "#src/components/QuestTextFields.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Select } from "#src/ui/Field.tsx";

/** A cooldown a fresh "unlimited" choice starts with, in minutes; the organizer changes it. */
const DEFAULT_COOLDOWN = 30;

const numberOrEmpty = (value: unknown): number | string =>
  typeof value === "number" || typeof value === "string" ? value : "";

/**
 * A mini-game quest (T-305, T-305c, FR-1804 to FR-1807): one of the four games (the real-time pair with a note that
 * they need quick sight and touch), its level with the target in words, and the attempts (1 to 10, or unlimited with
 * minutes between rounds), with the line players will see.
 */
export function GameFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const game = isGameName(config["game"]) ? config["game"] : "memory_match";
  const level = isGameLevel(config["level"]) ? config["level"] : "easy";
  const unlimited = config["attempts"] === null;
  const preview = targetWords(t, gameTarget(game, LEVELS[game][level]), language);
  return (
    <>
      <Muted>{t("quests.game.note")}</Muted>
      <Field label={t("quests.game.game")}>
        <Select
          value={game}
          disabled={disabled}
          onChange={(picked) => change({ ...config, game: picked.target.value })}
        >
          {GAME_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(GAME_NAME_KEYS[name])}
            </option>
          ))}
        </Select>
      </Field>
      {game === "catch" || game === "tap_rush" ? <Muted>{t("quests.game.quickNote")}</Muted> : null}
      <Field label={t("quests.game.level")}>
        <Select
          value={level}
          disabled={disabled}
          onChange={(picked) => change({ ...config, level: picked.target.value })}
        >
          {GAME_LEVELS.map((name) => (
            <option key={name} value={name}>
              {t(GAME_LEVEL_KEYS[name])}
            </option>
          ))}
        </Select>
      </Field>
      <Checkbox
        label={t("quests.game.unlimited")}
        checked={unlimited}
        disabled={disabled}
        onChange={(picked) =>
          change(
            picked.target.checked
              ? { ...config, attempts: null, cooldownMinutes: DEFAULT_COOLDOWN }
              : { ...config, attempts: GAME_ATTEMPTS.default, cooldownMinutes: null },
          )
        }
      />
      {unlimited ? (
        <NumberField
          label={t("quests.game.cooldown")}
          value={numberOrEmpty(config["cooldownMinutes"])}
          invalid={false}
          disabled={disabled}
          change={(text) => change({ ...config, cooldownMinutes: text === "" ? "" : Number(text) })}
        />
      ) : (
        <NumberField
          label={t("quests.game.attempts")}
          value={numberOrEmpty(config["attempts"])}
          invalid={false}
          disabled={disabled}
          change={(text) => change({ ...config, attempts: text === "" ? "" : Number(text) })}
        />
      )}
      <Muted dir="auto">{t("quests.game.preview", { target: preview })}</Muted>
    </>
  );
}
