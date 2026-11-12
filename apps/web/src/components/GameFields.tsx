"use client";

import {
  GAME_ATTEMPTS,
  GAME_IMAGE_LIMITS,
  GAME_LEVEL_KEYS,
  GAME_LEVELS,
  GAME_NAME_KEYS,
  GAME_NAMES,
  LEVELS,
  gameTarget,
  isGameLevel,
  isGameName,
  targetWords,
  type MessageKey,
} from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { ImageField, useImagesOn } from "#src/components/ImageField.tsx";
import { NumberField } from "#src/components/NumberField.tsx";
import type { TypeFieldProps } from "#src/components/QuestTextFields.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Select } from "#src/ui/Field.tsx";

/** A cooldown a fresh "unlimited" choice starts with, in minutes; the organizer changes it. */
const DEFAULT_COOLDOWN = 30;

const numberOrEmpty = (value: unknown): number | string =>
  typeof value === "number" || typeof value === "string" ? value : "";

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** A game's art field: the field of `images` it fills, the kind of image, how many, and each picture's words. */
const ART: Readonly<
  Record<
    string,
    Readonly<{ field: "faces" | "picture" | "items"; most: number; label: MessageKey }>
  >
> = {
  memory_match: { field: "faces", most: GAME_IMAGE_LIMITS.faces, label: "image.face" },
  slide_puzzle: { field: "picture", most: 1, label: "image.puzzle" },
  catch: { field: "items", most: GAME_IMAGE_LIMITS.items, label: "image.item" },
};

/**
 * The organizer's art for a game (T-305b): card faces (icons) for memory match, the slide puzzle's picture, catch's
 * falling items (icons); tap rush has none. Each saved picture can be replaced or removed, and one more can be added
 * while there is room; the game draws its default art for the rest. Shown only where this server stores images.
 */
function GameArt({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const on = useImagesOn();
  const art = ART[String(config["game"])];
  if (!on || art === undefined) return null;
  const images = (config["images"] ?? {}) as Record<string, unknown>;
  const list =
    art.field === "picture"
      ? typeof images["picture"] === "string"
        ? [images["picture"]]
        : []
      : idsOf(images[art.field]);
  const save = (next: readonly string[]) => {
    const { images: _old, ...rest } = config;
    if (next.length === 0) change(rest);
    else
      change({ ...rest, images: { [art.field]: art.field === "picture" ? next[0] : [...next] } });
  };
  const purpose = art.field === "picture" ? "picture" : "icon";
  return (
    <FieldGroup legend={t("image.gameArt")}>
      {[...list, ...(list.length < art.most ? [null] : [])].map((id, index) => (
        <ImageField
          key={id === null ? "new" : `${index}:${id}`}
          language={language}
          purpose={purpose}
          label={t(art.label, { n: index + 1 })}
          value={id}
          disabled={disabled}
          onChange={(picked) => {
            if (id === null) {
              if (picked !== null) save([...list, picked]);
              return;
            }
            save(
              picked === null
                ? list.filter((_, at) => at !== index)
                : list.map((old, at) => (at === index ? picked : old)),
            );
          }}
        />
      ))}
    </FieldGroup>
  );
}

/**
 * A mini-game quest (T-305, T-305c, FR-1804 to FR-1807): one of the four games (the real-time pair with a note that
 * they need quick sight and touch), its level with the target in words, the attempts (1 to 10, or unlimited with
 * minutes between rounds), with the line players will see, and the organizer's art (T-305b).
 */
export function GameFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const game = isGameName(config["game"]) ? config["game"] : "memory_match";
  const level = isGameLevel(config["level"]) ? config["level"] : "easy";
  const unlimited = config["attempts"] === null;
  const preview = targetWords(t, gameTarget(game, LEVELS[game][level]), language);
  return (
    <>
      <Field label={t("quests.game.game")}>
        <Select
          value={game}
          disabled={disabled}
          onChange={(picked) => {
            // Each game takes its own art: a new game starts with the default.
            const { images: _art, ...rest } = config;
            change({ ...rest, game: picked.target.value });
          }}
        >
          {GAME_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(GAME_NAME_KEYS[name])}
            </option>
          ))}
        </Select>
      </Field>
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
      <GameArt language={language} config={config} disabled={disabled} change={change} />
    </>
  );
}
