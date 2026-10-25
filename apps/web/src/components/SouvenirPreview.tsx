import { frameDesign, type ProfileItem, type Language } from "@questify/shared";

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
        borderRadius: frame?.rounded === false ? "25%" : "50%",
      }}
    >
      {frame === null ? null : (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "inherit",
            border: `4px ${frame.double ? "dashed" : "solid"} ${frame.color}`,
          }}
        />
      )}
      {frame?.motif === true ? (
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
      {/* Shipped local artwork, never organizer-provided URLs. */}
      <img
        src={item.kind === "character" ? "/souvenirs/chest.png" : "/avatars/falcon.png"}
        alt=""
        width={42}
        height={42}
        style={{ objectFit: "contain" }}
      />
    </div>
  );
}
