import { RobotHead } from "robot-heads";

const EMERALD = "#00d47e";

/** The SimplyCode robot mark; the wordmark next to it carries the accessible name. */
export function SimplyCodeLogo({ size = 20 }: { readonly size?: number }) {
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
        filter: `drop-shadow(0 0 10px ${EMERALD}aa) drop-shadow(0 0 26px ${EMERALD}66)`,
      }}
    />
  );
}
