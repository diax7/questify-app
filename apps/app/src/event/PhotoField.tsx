import type { MessageKey } from "@questify/shared";
import { createContext, useState } from "react";
import { Image, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { photoBytes, photoPickerPresent, pickPhoto } from "#src/event/photo-picker.ts";
import { pickLine, uploadPhoto, type PickedPhoto, type UploadAnswer } from "#src/event/photos.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * Whether this server stores photos (T-301b), as the event's Home said: the help form offers a photo only then. Off by
 * default, so a server without a bucket (or an older one) never shows a photo it would refuse.
 */
export const PhotosOn = createContext(false);

/** A picked photo with its one Idempotency-Key, and the id the server gave it once uploaded. */
export type PhotoDraft = Readonly<{ photo: PickedPhoto; key: string; photoId: string | null }>;

export type PhotoDraftState = Readonly<{
  draft: PhotoDraft | null;
  /** The draft's photo, or null. */
  photo: PickedPhoto | null;
  note: MessageKey | null;
  uploading: boolean;
  pick: (source: "camera" | "library") => Promise<void>;
  clear: () => void;
  /** Uploads the draft once (a retry keeps its key); answers its id, or why it could not. */
  upload: (path: string) => Promise<UploadAnswer>;
}>;

/** The photo a player is about to send (T-301b): taken or picked, previewed, changed or removed, uploaded once. */
export function usePhotoDraft(): PhotoDraftState {
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  const [note, setNote] = useState<MessageKey | null>(null);
  const [uploading, setUploading] = useState(false);
  const pick = async (source: "camera" | "library") => {
    const answer = await pickPhoto(source);
    setNote(pickLine(answer));
    if (answer.kind === "picked")
      setDraft({ photo: answer.photo, key: randomUuid(), photoId: null });
  };
  const upload = async (path: string): Promise<UploadAnswer> => {
    if (draft === null) return { kind: "network" };
    if (draft.photoId !== null) return { kind: "uploaded", photoId: draft.photoId };
    setUploading(true);
    try {
      const data = await photoBytes(draft.photo);
      const answer = await uploadPhoto(
        api.session,
        path,
        { data, type: draft.photo.type },
        draft.key,
      );
      if (answer.kind === "uploaded") setDraft({ ...draft, photoId: answer.photoId });
      return answer;
    } catch {
      return { kind: "network" };
    } finally {
      setUploading(false);
    }
  };
  const photo = draft === null ? null : draft.photo;
  return { draft, photo, note, uploading, pick, clear: () => setDraft(null), upload };
}

/**
 * Take or choose a photo, then its preview with Remove, which offers both again (T-301b). In a build without the picker (an update
 * that reached an older binary) it asks for an app update instead. Only the event team sees the photo (FR-205).
 */
export function PhotoField({
  state,
  disabled,
}: Readonly<{ state: PhotoDraftState; disabled: boolean }>) {
  const { t } = useI18n();
  const { draft, note, uploading } = state;
  if (!photoPickerPresent()) return <AppText muted>{t("photo.updateApp")}</AppText>;
  const busy = disabled || uploading;
  return (
    <View style={{ gap: 8 }}>
      {draft === null ? (
        <>
          <Button
            label={t("photo.take")}
            disabled={busy}
            onPress={() => void state.pick("camera")}
          />
          <Button
            kind="quiet"
            label={t("photo.choose")}
            disabled={busy}
            onPress={() => void state.pick("library")}
          />
        </>
      ) : (
        <>
          <Image
            source={{ uri: draft.photo.uri }}
            accessibilityLabel={t("photo.preview")}
            style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: 12 }}
            resizeMode="cover"
          />
          <Button kind="quiet" label={t("photo.remove")} disabled={busy} onPress={state.clear} />
        </>
      )}
      {uploading ? (
        <AppText accessibilityLiveRegion="polite">{t("photo.uploading")}</AppText>
      ) : null}
      {note === null ? null : <AppText accessibilityRole="alert">{t(note)}</AppText>}
    </View>
  );
}
