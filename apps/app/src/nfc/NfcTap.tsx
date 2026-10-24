import { useEffect, useRef, useState } from "react";
import { AppState, Platform, type NativeEventSubscription } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { nfcModule, readTag, stopReading } from "#src/nfc/native.ts";
import { tapLoop, type ActiveWait } from "#src/nfc/tap-loop.ts";

/** Whether this phone reads NFC tags: undefined while it is being asked, false without NFC or the module. */
export function useNfcSupported(): boolean | undefined {
  const [supported, setSupported] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void nfcModule().then((module) => {
      if (current) {
        setSupported(module !== null);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return supported;
}

/** A tag read for a tap: its URL (null when it holds none of ours to read) and the sticker's id. */
export type TapRead = Readonly<{ url: string | null; uid: string | null }>;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The app coming back to the front (from Settings, after switching NFC on). */
function untilActive(): ActiveWait {
  let subscription: NativeEventSubscription | undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
    subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        subscription?.remove();
        resolve();
      }
    });
  });
  return {
    done,
    cancel: () => {
      subscription?.remove();
      finish?.();
    },
  };
}

/**
 * NFC in the scanner (FR-621). Android: reader mode runs while `active`, so a tag is read beside the camera and never
 * opens the browser; NFC switched off shows a hint until the person comes back with it on. iOS: a button opens the system sheet (no silent reading on the iPhone); `autoStart` opens it at
 * once when the quest sheet's "Tap the NFC tag" brought the player here. Hidden on a phone without NFC.
 */
export function NfcTap({
  active,
  autoStart,
  onRead,
}: Readonly<{ active: boolean; autoStart: boolean; onRead: (read: TapRead) => void }>) {
  const { t } = useI18n();
  const supported = useNfcSupported();
  const [failed, setFailed] = useState(false);
  const [off, setOff] = useState(false);
  const started = useRef(false);
  const reading = useRef(onRead);
  reading.current = onRead;
  const ios = Platform.OS === "ios";

  useEffect(() => {
    if (ios || supported !== true || !active) {
      return;
    }
    return tapLoop({
      read: () => readTag(t("scanner.nfc.hold")),
      onRead: (read) => reading.current(read),
      onOff: setOff,
      untilActive,
      pause,
      stopReading: () => void stopReading(),
    });
  }, [ios, supported, active, t]);

  const tapOnce = async () => {
    setFailed(false);
    const read = await readTag(t("scanner.nfc.holdIos"));
    if (read.kind === "read") {
      reading.current(read);
    } else if (read.kind === "failed") {
      setFailed(true);
    }
  };

  useEffect(() => {
    if (ios && supported === true && active && autoStart && !started.current) {
      started.current = true;
      void tapOnce();
    }
  });

  if (supported !== true || !active) {
    return null;
  }
  return (
    <>
      {ios ? (
        <Button kind="quiet" label={t("scanner.nfc.button")} onPress={() => void tapOnce()} />
      ) : (
        <AppText muted>{t(off ? "scanner.nfc.off" : "scanner.nfc.androidHint")}</AppText>
      )}
      {failed ? <AppText accessibilityRole="alert">{t("scanner.nfc.failed")}</AppText> : null}
    </>
  );
}
