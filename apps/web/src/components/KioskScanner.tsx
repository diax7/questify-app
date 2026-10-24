"use client";

import { AVATARS, formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DevicePairing } from "#src/components/DevicePairing.tsx";
import { useWakeLock } from "#src/components/StationScreen.tsx";
import { shutKey, type PairedView } from "#src/lib/device.ts";
import {
  KIOSK_CARD_MS,
  KIOSK_FRAME_MS,
  ZXING_WASM_PATH,
  createKioskReader,
  frameSize,
  kioskShutKey,
  reasonKey,
  storeFacing,
  storedFacing,
  type Facing,
  type KioskCard,
  type KioskOutcome,
  type KioskPlayer,
} from "#src/lib/kiosk.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import styles from "#src/components/device.module.css";

type Camera = "idle" | "starting" | "live" | "denied" | "none";
type Banner = "slowed" | "reconnecting" | "off" | null;

const localStore = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The camera (FR-315): opened on a tap ("Allow the camera", as iOS Safari wants a gesture), muted and inline, the front
 * one by default. Its frames stay on this page: only a decoded string is ever sent.
 */
function useCamera(video: RefObject<HTMLVideoElement | null>) {
  const [camera, setCamera] = useState<Camera>("idle");
  const stream = useRef<MediaStream | null>(null);
  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);
  const start = useCallback(
    async (facing: Facing) => {
      stop();
      if (navigator.mediaDevices?.getUserMedia === undefined) {
        setCamera("none");
        return;
      }
      setCamera("starting");
      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        stream.current = opened;
        if (video.current !== null) {
          video.current.srcObject = opened;
          await video.current.play().catch(() => undefined);
        }
        setCamera("live");
      } catch (error) {
        const name = (error as { name?: string }).name;
        setCamera(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
      }
    },
    [stop, video],
  );
  useEffect(() => stop, [stop]);
  return { camera, start };
}

/**
 * Decodes the camera 4 times a second on this device (ADR-245): the frame is drawn to a canvas at most 640 pixels on its
 * longest side and read for one QR code by the self-hosted zxing-wasm reader, loaded by this page alone.
 */
function useDecoder(
  video: RefObject<HTMLVideoElement | null>,
  running: boolean,
  onText: (text: string) => void,
) {
  useEffect(() => {
    if (!running) {
      return;
    }
    let stopped = false;
    let busy = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const reader = import("zxing-wasm/reader").then((zxing) => {
      zxing.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? ZXING_WASM_PATH : `${prefix}${path}`,
        },
      });
      return zxing.readBarcodes;
    });
    const timer = setInterval(() => {
      const frame = video.current;
      if (busy || stopped || context === null || frame === null || frame.videoWidth === 0) {
        return;
      }
      busy = true;
      const size = frameSize(frame.videoWidth, frame.videoHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      context.drawImage(frame, 0, 0, size.width, size.height);
      const image = context.getImageData(0, 0, size.width, size.height);
      void reader
        .then((read) => read(image, { formats: ["QRCode"], maxNumberOfSymbols: 1 }))
        .then((results) => {
          const text = results.find((result) => result.isValid)?.text;
          if (!stopped && text !== undefined && text !== "") {
            onText(text);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, KIOSK_FRAME_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, onText, video]);
}

/** Whether the browser thinks it is online; offline, the camera keeps running but nothing is sent. */
function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** The scans: each decoded string through the kiosk reader, the 4-second card, and the banners it leads to. */
function useScans(restart: () => void) {
  const [card, setCard] = useState<KioskCard | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const until = useRef(0);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onOutcome = useCallback(
    (outcome: KioskOutcome) => {
      if (outcome.kind === "unpaired") {
        restart();
        return;
      }
      if (outcome.kind === "card") {
        setBanner(null);
        setCard(outcome.card);
        clearTimeout(cardTimer.current);
        cardTimer.current = setTimeout(() => setCard(null), KIOSK_CARD_MS);
        return;
      }
      const forMs = outcome.kind === "slowed" ? outcome.forMs : KIOSK_CARD_MS;
      until.current = Date.now() + forMs;
      setBanner(outcome.kind);
      setTimeout(() => setBanner((now) => (Date.now() >= until.current ? null : now)), forMs);
    },
    [restart],
  );
  const reader = useMemo(
    () =>
      createKioskReader({
        send: (code, key) =>
          requestJson("POST", "/v1/device/kiosk-scans", { code }, { "idempotency-key": key }),
        newKey: () => crypto.randomUUID(),
        now: () => Date.now(),
        onOutcome,
      }),
    [onOutcome],
  );
  useEffect(() => () => clearTimeout(cardTimer.current), []);
  const read = useCallback(
    (text: string) => {
      if (Date.now() >= until.current) {
        reader.read(text);
      }
    },
    [reader],
  );
  return { card, banner, read };
}

/** A player's avatar on a card: Questify's own picture, or the username's first letter for one this page lacks. */
function CardAvatar({ player }: Readonly<{ player: KioskPlayer }>) {
  const known = AVATARS.find((avatar) => avatar === player.avatar);
  return known === undefined ? (
    <span className={styles.avatar} aria-hidden="true">
      {player.username.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img className={styles.avatar} src={`/avatars/${known}.png`} alt="" width={96} height={96} />
  );
}

/** The card for 4 seconds after a scan: green with the points, orange, or red with the reason only. */
function ResultCard({ card, language }: Readonly<{ card: KioskCard; language: Language }>) {
  const t = translatorFor(language);
  if (card.kind === "refused") {
    return (
      <div className={`${styles.card} ${styles.cardRed}`} role="status" aria-live="assertive">
        <p className={styles.message}>{t(reasonKey(card.reason))}</p>
      </div>
    );
  }
  const tone = card.kind === "paid" ? styles.cardGreen : styles.cardOrange;
  return (
    <div className={`${styles.card} ${tone}`} role="status" aria-live="assertive">
      {card.player === null ? null : (
        <>
          <CardAvatar player={card.player} />
          <p className={styles.event} dir="ltr">
            @{card.player.username}
          </p>
        </>
      )}
      <p className={styles.message}>
        {card.kind === "paid"
          ? t("kiosk.paid", { points: formatNumber(card.points, language) })
          : t("kiosk.already")}
        {card.kind === "paid" && card.boosted ? ` ${t("kiosk.boosted")}` : null}
      </p>
    </div>
  );
}

/** The camera area: Allow, denied, none, or the live view (mirrored for the front camera) with Switch camera. */
function CameraArea({
  camera,
  facing,
  video,
  start,
  flip,
  language,
}: Readonly<{
  camera: Camera;
  facing: Facing;
  video: RefObject<HTMLVideoElement | null>;
  start: () => void;
  flip: () => void;
  language: Language;
}>) {
  const t = translatorFor(language);
  const shown = camera === "live" || camera === "starting";
  return (
    <>
      <video
        ref={video}
        className={styles.camera}
        style={{
          display: shown ? "block" : "none",
          transform: facing === "user" ? "scaleX(-1)" : undefined,
        }}
        muted
        playsInline
        autoPlay
        aria-label={t("kiosk.camera.label")}
      />
      {camera === "idle" ? (
        <button type="button" className={styles.bigButton} onClick={start}>
          {t("kiosk.camera.allow")}
        </button>
      ) : camera === "denied" ? (
        <p className={styles.message} role="alert">
          {t("kiosk.camera.denied")}
        </p>
      ) : camera === "none" ? (
        <p className={styles.message} role="alert">
          {t("kiosk.camera.none")}
        </p>
      ) : (
        <button type="button" className={styles.quietButton} onClick={flip}>
          {t("kiosk.camera.switch")}
        </button>
      )}
    </>
  );
}

function Kiosk({
  view,
  language,
  restart,
}: Readonly<{ view: PairedView; language: Language; restart: () => void }>) {
  const t = translatorFor(language);
  useWakeLock();
  const video = useRef<HTMLVideoElement | null>(null);
  const [facing, setFacing] = useState<Facing>("user");
  useEffect(() => setFacing(storedFacing(localStore())), []);
  const { camera, start } = useCamera(video);
  const online = useOnline();
  const { card, banner, read } = useScans(restart);
  const shut = view.shut;
  useDecoder(video, camera === "live" && online && shut === null, read);
  const flip = () => {
    const next: Facing = facing === "user" ? "environment" : "user";
    storeFacing(localStore(), next);
    setFacing(next);
    void start(next);
  };
  if (shut === "event_ended") {
    return (
      <main className={styles.screen}>
        <p className={styles.mark}>Questify</p>
      </main>
    );
  }
  const quest = view.quest;
  return (
    <main className={styles.screen}>
      <p className={styles.event} dir="auto">
        {textFor(view.event.name, language)}
      </p>
      {quest === null ? null : (
        <>
          <h1 className={styles.title} dir="auto">
            {textFor(quest.title, language)}
          </h1>
          <p className={styles.points}>
            {t("station.points", { points: formatNumber(quest.points, language) })}
          </p>
        </>
      )}
      {shut !== null ? (
        <p className={styles.message} role="status">
          {t(kioskShutKey(shut) ?? shutKey(shut))}
        </p>
      ) : (
        <>
          <p className={styles.message}>{t("kiosk.show")}</p>
          <p className={styles.muted}>{t("kiosk.howTo")}</p>
          <CameraArea
            camera={camera}
            facing={facing}
            video={video}
            start={() => void start(facing)}
            flip={flip}
            language={language}
          />
          {!online || banner !== null ? (
            <p className={styles.message} role="status">
              {t(
                banner === "slowed"
                  ? "kiosk.slowDown"
                  : banner === "off"
                    ? "device.notAvailable"
                    : "device.reconnecting",
              )}
            </p>
          ) : null}
          {card === null ? null : <ResultCard card={card} language={language} />}
        </>
      )}
      <p className={styles.corner} dir="auto">
        {view.label}
      </p>
    </main>
  );
}

/** The kiosk page (T-309b, FR-315): pairing first, then the camera that reads players' live codes with no staff by. */
export function KioskScanner({ language }: Readonly<{ language: Language }>) {
  return (
    <DevicePairing kind="kiosk" language={language}>
      {(view, restart) => <Kiosk view={view} language={language} restart={restart} />}
    </DevicePairing>
  );
}
