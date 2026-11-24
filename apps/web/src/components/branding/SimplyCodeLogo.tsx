import { RobotHead } from "robot-heads";

const EMERALD = "#00d47e";

/** The SimplyCode robot mark; the wordmark next to it carries the accessible name. */
export function SimplyCodeLogo({ size = 20 }: { readonly size?: number }) {
  const near = Math.round(size * 0.3);
  const far = Math.round(size * 0.7);
  return (
    <RobotHead
      shape="rectangle"
      state="happy"
      size={size}
      color={EMERALD}
      trimColor="#a7f3d0"
      screenColor="#eafff5"
      paused
      interactive={false}
      floorShadow={false}
      antenna={size >= 40}
      aria-hidden
      style={{
        filter: `drop-shadow(0 0 ${near}px ${EMERALD}aa) drop-shadow(0 0 ${far}px ${EMERALD}66)`,
      }}
    />
  );
}
