import { botAvatarOrDefault, type BotAvatar as BotAvatarValue } from "@t3tools/contracts";
import { RobotHead, type RobotHeadState } from "robot-heads";

export function BotAvatar(props: {
  readonly bot: {
    readonly id: string;
    readonly name: string;
    readonly avatar?: BotAvatarValue | undefined;
    readonly enabled?: boolean;
  };
  readonly size: number;
  readonly state?: RobotHeadState;
  /** Canvas animations are off by default so rows of avatars repaint nothing. */
  readonly animated?: boolean;
  readonly glow?: boolean;
  readonly className?: string;
}) {
  const { bot, size, state, animated = false, glow = false, className } = props;
  const avatar = botAvatarOrDefault(bot);
  const disabled = bot.enabled === false;
  return (
    <RobotHead
      shape={avatar.shape}
      state={state ?? (disabled ? "sleeping" : "idle")}
      size={size}
      color={avatar.color}
      paused={!animated}
      interactive={false}
      floorShadow={false}
      antenna={size >= 40}
      aria-label={bot.name}
      {...(className === undefined ? {} : { className })}
      style={{
        ...(disabled ? { opacity: 0.55 } : null),
        ...(glow
          ? {
              filter: `drop-shadow(0 0 8px ${avatar.color}99) drop-shadow(0 0 20px ${avatar.color}55)`,
            }
          : null),
      }}
    />
  );
}
