"use client";

import {
  COMING_GAMES,
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
import styles from "#src/components/layout.module.css";

/** A cooldown a fresh "unlimited" choice starts with, in minutes; the organizer changes it. */
const DEFAULT_COOLDOWN = 30;

const numberOrEmpty = (value: unknown): number | string =>
  typeof value === "number" || typeof value === "string" ? value : "";

/**
 * A mini-game quest (T-305, FR-1804 to FR-1807): the game (catch and tap rush shown as coming soon, ADR-214), its level
 * with the target in words, and the attempts (1 to 10, or unlimited with minutes between rounds), with the line players
 * will see.
 */
export function GameFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const game = isGameName(config["game"]) ? config["game"] : "memory_match";
  const level = isGameLevel(config["level"]) ? config["level"] : "easy";
  const unlimited = config["attempts"] === null;
  const preview = targetWords(t, gameTarget(game, LEVELS[game][level]), language);
  return (
    <>
      <p className={styles.muted}>{t("quests.game.note")}</p>
      <label className={styles.field}>
        {t("quests.game.game")}
        <select
          className={styles.input}
          value={game}
          disabled={disabled}
          onChange={(picked) => change({ ...config, game: picked.target.value })}
        >
          {GAME_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(GAME_NAME_KEYS[name])}
            </option>
          ))}
          {COMING_GAMES.map((name) => (
            <option key={name} value={name} disabled>
              {t("quests.game.comingSoon", { game: t(GAME_NAME_KEYS[name]) })}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        {t("quests.game.level")}
        <select
          className={styles.input}
          value={level}
          disabled={disabled}
          onChange={(picked) => change({ ...config, level: picked.target.value })}
        >
          {GAME_LEVELS.map((name) => (
            <option key={name} value={name}>
              {t(GAME_LEVEL_KEYS[name])}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
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
        <span>{t("quests.game.unlimited")}</span>
      </label>
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
      <p className={styles.muted} dir="auto">
        {t("quests.game.preview", { target: preview })}
      </p>
    </>
  );
}
