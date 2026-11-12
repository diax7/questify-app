import { requireOptionalNativeModule } from "expo";
import type * as ImagePicker from "expo-image-picker";
import { photoTypeOf, type PickAnswer, type PickedPhoto } from "#src/event/photos.ts";

/**
 * The camera and the system photo picker for photo quests and help requests (T-301b), through `expo-image-picker`. Its
 * native module (`ExponentImagePicker`) is looked up with `requireOptionalNativeModule`, which answers null in a build
 * that lacks it (an update reaching an older binary), where a plain import would throw as the screen loads (ADR-339).
 * The picker is the system's own: it needs no photo-library permission (`photosPermission: false`, READ_MEDIA_* stay
 * blocked); the camera asks for the camera permission the QR scan already uses.
 */
export const photoPickerPresent = (): boolean =>
  requireOptionalNativeModule("ExponentImagePicker") != null;

/** Quality 0.8 keeps a phone photo to about 1 to 3 MB; iOS hands over a JPEG, never HEIC (plan section 10, item 7). */
const optionsOf = (picker: typeof ImagePicker): ImagePicker.ImagePickerOptions => ({
  mediaTypes: ["images"],
  quality: 0.8,
  exif: false,
  allowsEditing: false,
  preferredAssetRepresentationMode: picker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
});

/** What the camera or the picker answered, as the sheet reads it; a JPEG when the asset names no type. */
function answerOf(result: ImagePicker.ImagePickerResult): PickAnswer {
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined) return { kind: "cancelled" };
  const type = photoTypeOf(asset.mimeType ?? "image/jpeg");
  return type === undefined
    ? { kind: "unsupported" }
    : { kind: "picked", photo: { uri: asset.uri, type, file: null } };
}

/** Takes a photo with the camera, or picks one from the system picker. */
export async function pickPhoto(source: "camera" | "library"): Promise<PickAnswer> {
  if (!photoPickerPresent()) return { kind: "unavailable" };
  const picker = require("expo-image-picker") as typeof ImagePicker;
  if (source === "library")
    return answerOf(await picker.launchImageLibraryAsync(optionsOf(picker)));
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) return { kind: "denied" };
  return answerOf(await picker.launchCameraAsync(optionsOf(picker)));
}

/** The bytes of a picked photo, read from its local file URI. */
export async function photoBytes(photo: PickedPhoto): Promise<Blob> {
  return (await fetch(photo.uri)).blob();
}
