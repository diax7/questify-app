import * as ImagePicker from "expo-image-picker";
import { photoTypeOf, type PickAnswer, type PickedPhoto } from "#src/event/photos.ts";

/**
 * The web build's photo picker (T-301b, `/play`): the browser's own file input through `expo-image-picker`'s web
 * module, which needs no native code. The camera opens the device camera where the browser offers it.
 */
export const photoPickerPresent = (): boolean => true;

export async function pickPhoto(source: "camera" | "library"): Promise<PickAnswer> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.8 };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined) return { kind: "cancelled" };
  const type = photoTypeOf(asset.mimeType);
  if (type === undefined || asset.file === undefined) return { kind: "unsupported" };
  return { kind: "picked", photo: { uri: asset.uri, type, file: asset.file } };
}

/** The bytes of a picked photo: the browser's file itself (the page's CSP lets it fetch no `blob:` or `data:` URI). */
export async function photoBytes(photo: PickedPhoto): Promise<Blob> {
  if (photo.file === null) throw new Error("A picked photo on the web carries its file.");
  return photo.file;
}
