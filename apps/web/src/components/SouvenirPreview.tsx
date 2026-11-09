import { frameDesign, type ProfileItem, type Language } from "@questify/shared";

/** The ring over the preview's border and, for a motif frame, the small diamond on top; nothing without a frame. */
function FrameOverlay({ frame }: { frame: ReturnType<typeof frameDesign> }) {
  if (frame === null) return null;
  return (
    <>
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          border: `4px ${frame.double ? "dashed" : "solid"} ${frame.color}`,
        }}
      />
      {frame.motif ? (
        <span
          style={{
            position: "absolute",
            top: 0,
            width: 5,
            height: 5,
            background: "#8B5A2B",
            transform: "rotate(45deg)",
          }}
        />
      ) : null}
    </>
  );
}

/** Same finite design vocabulary as the native locker, always contained inside its64px preview. */
export function SouvenirPreview({ item, language }: { item: ProfileItem; language: Language }) {
  const frame = item.kind === "frame" ? frameDesign(item.visualKey) : null;
  if (item.kind === "title") return <strong>{item.name[language]}</strong>;
  return (
    <div
      aria-hidden="true"
      style={{
        width: 64,
        height: 64,
        position: "relative",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        border: "4px solid #8B5A2B",
        borderRadius: frame !== null && !frame.rounded ? "25%" : "50%",
      }}
    >
      <FrameOverlay frame={frame} />
      {/* Shipped local artwork, never organizer-provided URLs. */}
      <img
        src={item.kind === "character" ? "/souvenirs/chest.webp" : "/avatars/falcon.webp"}
        alt=""
        width={42}
        height={42}
        style={{ objectFit: "contain" }}
      />
    </div>
  );
}
